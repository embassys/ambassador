import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { type FakeCentral, startFakeCentral } from "../fake-central.js";
import { TestMcpClient } from "../mcp-client.js";
import {
  startV2ManagedProcess,
  type V2ManagedProcess,
  v2NodeProcessEnvironment,
} from "../v2-process-runtime.js";
import { K04_EMAIL, K04_INBOUND_TEXT, K04_USERNAME, K04_WEBHOOK_TOKEN } from "./k04-constants.js";

export { K04_REPLY_TEXT, K04_WEBHOOK_TOKEN } from "./k04-constants.js";

const ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface K04Fixture {
  readonly central: FakeCentral;
  readonly rootDirectory: string;
  readonly gatewayArtifactRoot: string;
  readonly connectorStateDirectory: string;
  readonly workingDirectory: string;
  readonly webhookPort: number;
  readonly inboundText: string;
}

export interface K04ProviderRequestRecord {
  readonly kind: "start" | "resume" | "recover";
  readonly conversationId: string;
  readonly messageId: string;
  readonly providerSessionId: string | null;
}

export interface K04ConnectorControl {
  providerRequests(): readonly K04ProviderRequestRecord[];
  waitForProviderRequests(count: number): Promise<void>;
  waitForProviderBarriers(count: number): Promise<void>;
  releaseProviderBarrier(): void;
}

export interface K04ConnectorProcess {
  readonly process: V2ManagedProcess;
  readonly control: K04ConnectorControl;
  readonly webhookUrl: string;
}

export type K04GatewayFetchBarrier =
  | "receive_selected"
  | "wake_before_request"
  | "reply_accepted_unobserved"
  | "ack_accepted_unobserved";

export type K04GatewayOperation = "receive" | "wake" | "reply" | "complete" | "outcome" | "ack";

export interface K04GatewayControl {
  operations(): readonly K04GatewayOperation[];
  waitForFetchBarrier(barrier: K04GatewayFetchBarrier): Promise<void>;
  releaseFetchBarrier(barrier: K04GatewayFetchBarrier): void;
}

export interface K04GatewayProcess {
  readonly process: V2ManagedProcess;
  readonly control: K04GatewayControl;
  readonly endpoint: string;
}

interface Capture {
  readonly name: string;
  readonly value: string;
}

interface Marker {
  readonly name: string;
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port >= 1_024 && port <= 65_535 && port !== 8_787);
  return port;
}

function connectorControl(process: V2ManagedProcess): K04ConnectorControl {
  const records: K04ProviderRequestRecord[] = [];
  let barrierCount = 0;
  const requestWaiters = new Set<{ count: number; resolve: () => void }>();
  const barrierWaiters = new Set<{ count: number; resolve: () => void }>();
  process.child.on("message", (message: unknown) => {
    if (
      isRecord(message) &&
      message.channel === "k04" &&
      message.event === "provider_barrier" &&
      message.name === "reply"
    ) {
      barrierCount += 1;
      for (const waiter of barrierWaiters) {
        if (barrierCount < waiter.count) continue;
        barrierWaiters.delete(waiter);
        waiter.resolve();
      }
      return;
    }
    if (
      !isRecord(message) ||
      message.channel !== "k04" ||
      message.event !== "provider_request" ||
      !["start", "resume", "recover"].includes(String(message.kind)) ||
      typeof message.conversation_id !== "string" ||
      !ID.test(message.conversation_id) ||
      typeof message.message_id !== "string" ||
      !ID.test(message.message_id) ||
      !(
        message.provider_session_id === null ||
        (typeof message.provider_session_id === "string" && ID.test(message.provider_session_id))
      )
    ) {
      return;
    }
    records.push({
      kind: message.kind as K04ProviderRequestRecord["kind"],
      conversationId: message.conversation_id,
      messageId: message.message_id,
      providerSessionId: message.provider_session_id,
    });
    for (const waiter of requestWaiters) {
      if (records.length < waiter.count) continue;
      requestWaiters.delete(waiter);
      waiter.resolve();
    }
  });
  const boundedWait = async (
    ready: () => boolean,
    subscribe: (resolve: () => void) => void,
  ): Promise<void> => {
    if (ready()) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => subscribe(resolve)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("K04 child did not reach its content-free IPC boundary")),
          10_000,
        );
        timer.unref();
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  return {
    providerRequests: () => records.map((record) => ({ ...record })),
    waitForProviderRequests: async (count) => {
      assert.ok(Number.isSafeInteger(count) && count >= 1);
      await boundedWait(
        () => records.length >= count,
        (resolve) => requestWaiters.add({ count, resolve }),
      );
    },
    waitForProviderBarriers: async (count) => {
      assert.ok(Number.isSafeInteger(count) && count >= 1);
      await boundedWait(
        () => barrierCount >= count,
        (resolve) => barrierWaiters.add({ count, resolve }),
      );
    },
    releaseProviderBarrier: () => {
      process.child.send({ channel: "k04_control", command: "release_provider_barrier" });
    },
  };
}

function gatewayControl(process: V2ManagedProcess): K04GatewayControl {
  const operations: K04GatewayOperation[] = [];
  const arrivals = new Map<K04GatewayFetchBarrier, number[]>();
  const waiters = new Map<K04GatewayFetchBarrier, Array<() => void>>();
  const releasable = new Map<K04GatewayFetchBarrier, number[]>();
  process.child.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== "k04_gateway_fetch") return;
    if (
      message.event === "request" &&
      ["receive", "wake", "reply", "complete", "outcome", "ack"].includes(String(message.operation))
    ) {
      operations.push(message.operation as K04GatewayOperation);
      return;
    }
    if (
      message.event !== "barrier" ||
      ![
        "receive_selected",
        "wake_before_request",
        "reply_accepted_unobserved",
        "ack_accepted_unobserved",
      ].includes(String(message.barrier)) ||
      !Number.isSafeInteger(message.sequence) ||
      (message.sequence as number) < 1
    ) {
      return;
    }
    const barrier = message.barrier as K04GatewayFetchBarrier;
    const sequence = message.sequence as number;
    const waiter = waiters.get(barrier)?.shift();
    if (waiter !== undefined) {
      const ready = releasable.get(barrier) ?? [];
      ready.push(sequence);
      releasable.set(barrier, ready);
      waiter();
      return;
    }
    const queued = arrivals.get(barrier) ?? [];
    queued.push(sequence);
    arrivals.set(barrier, queued);
  });
  return {
    operations: () => [...operations],
    waitForFetchBarrier: async (barrier) => {
      const queued = arrivals.get(barrier)?.shift();
      if (queued !== undefined) {
        const ready = releasable.get(barrier) ?? [];
        ready.push(queued);
        releasable.set(barrier, ready);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const pending = waiters.get(barrier) ?? [];
        pending.push(waiter);
        waiters.set(barrier, pending);
        const timer = setTimeout(() => {
          const current = waiters.get(barrier);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current?.splice(index, 1);
          reject(new Error(`K04 gateway did not reach ${barrier}`));
        }, 10_000);
        timer.unref();
      });
    },
    releaseFetchBarrier: (barrier) => {
      const sequence = releasable.get(barrier)?.shift();
      if (sequence === undefined) throw new Error(`${barrier} is not waiting for release`);
      process.child.send({
        channel: "k04_gateway_fetch_control",
        command: "release",
        barrier,
        sequence,
      });
    },
  };
}

export async function startK04Fixture(t: TestContext): Promise<K04Fixture> {
  const rootDirectory = await realpath(await mkdtemp(join(tmpdir(), "a2a-k04-")));
  const gatewayArtifactRoot = join(rootDirectory, "gateway");
  const connectorStateDirectory = join(rootDirectory, "connector-state");
  const workingDirectory = join(rootDirectory, "workspace");
  await Promise.all(
    [gatewayArtifactRoot, connectorStateDirectory, workingDirectory].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }),
  );
  t.after(async () => await rm(rootDirectory, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const systemSeconds = Math.floor(Date.now() / 1_000);
  if (systemSeconds > central.clock()) {
    central.advanceClock(systemSeconds - central.clock());
    central.refreshSeedCredentials();
  }
  return {
    central,
    rootDirectory,
    gatewayArtifactRoot,
    connectorStateDirectory,
    workingDirectory,
    webhookPort: await unusedLoopbackPort(),
    inboundText: K04_INBOUND_TEXT,
  };
}

export async function startK04ConnectorProcess(
  t: TestContext,
  fixture: K04Fixture,
  options: {
    readonly plan: "reply" | "safe-wait";
    readonly providerGate?: "reply";
    readonly crashAfter?:
      | "binding_published"
      | "turn_published"
      | "provider_terminal_received"
      | "reply_accepted";
    readonly clockOffsetMs?: number;
    readonly proveNoProviderDispatch?: boolean;
  },
): Promise<K04ConnectorProcess> {
  const managed = startV2ManagedProcess(t, {
    command: process.execPath,
    args: [
      `${process.cwd()}/.test-dist/test/support/connector/k04-connector-process.js`,
      "start",
      `--webhook-port=${fixture.webhookPort}`,
      "--webhook-token-env=K04_WEBHOOK_TOKEN",
      `--working-directory=${fixture.workingDirectory}`,
      "--policy=read-only",
    ],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      K04_PROVIDER_PLAN: options.plan,
      K04_STATE_DIRECTORY: fixture.connectorStateDirectory,
      K04_WEBHOOK_TOKEN,
      ...(options.providerGate === undefined ? {} : { K04_PROVIDER_GATE: options.providerGate }),
      ...(options.crashAfter === undefined ? {} : { K04_CRASH_AFTER: options.crashAfter }),
      ...(options.clockOffsetMs === undefined
        ? {}
        : { K04_CLOCK_OFFSET_MS: String(options.clockOffsetMs) }),
      ...(options.proveNoProviderDispatch === true ? { K04_PROVE_NO_PROVIDER_DISPATCH: "1" } : {}),
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 1_000,
    forcedStopMs: 2_000,
  });
  const control = connectorControl(managed);
  const webhookUrl = `http://127.0.0.1:${fixture.webhookPort}/webhook`;
  try {
    await managed.waitForOutput("stdout", `Connector webhook: ${webhookUrl}\n`);
  } catch {
    const exit = await managed.waitForExit();
    throw new Error(
      `K04 connector exited before readiness (${exit.code ?? exit.signal}): ${managed.stderr()}`,
    );
  }
  assert.equal(managed.stderr(), "");
  return { process: managed, control, webhookUrl };
}

export async function startK04GatewayProcess(
  t: TestContext,
  fixture: K04Fixture,
  webhookUrl: string,
  options: {
    readonly observeFetch?: boolean;
    readonly fetchBarrier?: K04GatewayFetchBarrier;
  } = {},
): Promise<K04GatewayProcess> {
  const observeFetch = options.observeFetch === true || options.fetchBarrier !== undefined;
  const managed = startV2ManagedProcess(t, {
    command: process.execPath,
    args: [
      `${process.cwd()}/.test-dist/test/support/v2-gateway-process.js`,
      "start",
      `--webhook-url=${webhookUrl}`,
      "--webhook-token-env=K04_WEBHOOK_TOKEN",
    ],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      A2A_DEV_CENTRAL_API_URL: fixture.central.apiUrl,
      A2A_DEV_CENTRAL_MCP_URL: fixture.central.mcpUrl,
      K04_WEBHOOK_TOKEN,
      XDG_STATE_HOME: join(fixture.gatewayArtifactRoot, "state"),
      ...(observeFetch
        ? {
            NODE_OPTIONS: `--import=${new URL("./k04-gateway-fetch-preload.js", import.meta.url).href}`,
            K04_GATEWAY_FETCH_PRELOAD: "1",
            K04_GATEWAY_FETCH_CENTRAL_ORIGIN: new URL(fixture.central.apiUrl).origin,
            K04_GATEWAY_FETCH_WEBHOOK_ORIGIN: new URL(webhookUrl).origin,
            ...(options.fetchBarrier === undefined
              ? {}
              : { K04_GATEWAY_FETCH_BARRIER: options.fetchBarrier }),
          }
        : {}),
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 1_000,
    forcedStopMs: 2_000,
  });
  const control = gatewayControl(managed);
  const endpoint = "http://127.0.0.1:8787/mcp";
  try {
    await managed.waitForOutput("stdout", `MCP endpoint: ${endpoint}\n`);
  } catch {
    const exit = await managed.waitForExit();
    throw new Error(
      `K04 gateway exited before readiness (${exit.code ?? exit.signal}): ${managed.stderr()}`,
    );
  }
  assert.equal(managed.stderr(), "");
  return { process: managed, control, endpoint };
}

export async function enrollK04Gateway(
  fixture: K04Fixture,
  endpoint: string,
): Promise<TestMcpClient> {
  const client = new TestMcpClient(endpoint, K04_WEBHOOK_TOKEN);
  await client.initialize();
  await client.callTool("register_agent", {
    username: K04_USERNAME,
    email: K04_EMAIL,
    display_name: "K04 fixture gateway",
  });
  await client.callTool("verify_email", { email: K04_EMAIL, code: "123456" });
  fixture.central.setConversationGrant(K04_USERNAME, "fixture_sender", true);
  return client;
}

export async function startK04InboundConversation(
  fixture: K04Fixture,
  requestId: string,
  text = fixture.inboundText,
): Promise<{ readonly messageId: string; readonly conversationId: string }> {
  const sender = fixture.central.seedClient("fixture_sender");
  const response = await sender.request(`${fixture.central.apiUrl}/api/v2/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": requestId,
    },
    body: JSON.stringify({ recipient_username: K04_USERNAME, payload: { text } }),
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as Record<string, unknown>;
  assert.ok(typeof result.message_id === "string" && ID.test(result.message_id));
  assert.ok(typeof result.conversation_id === "string" && ID.test(result.conversation_id));
  return { messageId: result.message_id, conversationId: result.conversation_id };
}

export async function waitForK04Acknowledgement(
  fixture: K04Fixture,
  messageId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.central.v2MessageState(messageId).acknowledged) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("K04 message was not acknowledged before the fixture deadline");
}

export async function receiveK04SenderMessage(
  fixture: K04Fixture,
  inReplyToMessageId: string,
): Promise<Record<string, unknown>> {
  const sender = fixture.central.seedClient("fixture_sender");
  const response = await sender.request(
    `${fixture.central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages?: unknown };
  assert.ok(Array.isArray(body.messages));
  const reply = body.messages.find(
    (candidate) => isRecord(candidate) && candidate.in_reply_to_message_id === inReplyToMessageId,
  );
  assert.ok(isRecord(reply));
  return reply;
}

export async function receiveK04SenderBatch(
  fixture: K04Fixture,
): Promise<readonly Record<string, unknown>[]> {
  const sender = fixture.central.seedClient("fixture_sender");
  const response = await sender.request(
    `${fixture.central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages?: unknown };
  assert.ok(Array.isArray(body.messages) && body.messages.every(isRecord));
  return body.messages;
}

export async function replyToK04SenderMessage(
  fixture: K04Fixture,
  messageId: string,
  text: string,
): Promise<{ readonly messageId: string; readonly conversationId: string }> {
  const sender = fixture.central.seedClient("fixture_sender");
  const idempotency = createHash("sha256").update(messageId, "utf8").digest("base64url");
  const response = await sender.request(
    `${fixture.central.apiUrl}/api/v2/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "idempotency-key": `reply.v1.${idempotency}`,
      },
      body: JSON.stringify({ payload: { text } }),
    },
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as Record<string, unknown>;
  assert.ok(typeof result.message_id === "string" && ID.test(result.message_id));
  assert.ok(typeof result.conversation_id === "string" && ID.test(result.conversation_id));
  const acknowledgement = await sender.request(
    `${fixture.central.apiUrl}/api/v2/messages/${messageId}/ack`,
    { method: "POST" },
  );
  assert.equal(acknowledgement.status, 200);
  return { messageId: result.message_id, conversationId: result.conversation_id };
}

export async function sendK04Wake(
  connector: K04ConnectorProcess,
  messageId: string,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  const timestamp = String(timestampSeconds);
  const body = JSON.stringify({
    message: `A2A message ${messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
    name: "A2A Gateway",
    deliver: false,
    wakeMode: "now",
  });
  const signature = createHmac("sha256", K04_WEBHOOK_TOKEN)
    .update(timestamp, "ascii")
    .update(".", "ascii")
    .update(body, "utf8")
    .digest("hex");
  return await fetch(connector.webhookUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${K04_WEBHOOK_TOKEN}`,
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "content-type": "application/json",
      "idempotency-key": messageId,
      "x-request-id": messageId,
      "x-webhook-signature-v2": signature,
      "x-webhook-timestamp": timestamp,
    },
    body,
  });
}

export async function stopK04ConnectorProcess(
  connector: K04ConnectorProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (connector.process.child.exitCode === null && connector.process.child.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      connector.process.child.send({ channel: "k04_control", command: "shutdown" }, (error) =>
        error === null ? resolve() : reject(error),
      );
    });
  }
  return await connector.process.waitForExit();
}

export async function scanK04Artifacts(options: {
  readonly fixture: K04Fixture;
  readonly captures: readonly Capture[];
  readonly markers: readonly Marker[];
}): Promise<void> {
  const child = spawn(process.execPath, [`${process.cwd()}/scripts/t02-artifact-scan.mjs`], {
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(
    JSON.stringify({
      roots: [options.fixture.rootDirectory],
      captures: options.captures.map((capture) => ({ ...capture, truncated: false })),
      markers: options.markers.map((marker) => ({
        name: marker.name,
        encoding: "utf8",
        value: marker.value,
      })),
    }),
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr || "K04 artifact scan failed");
  assert.equal(stderr, "");
  assert.match(stdout, /^artifact scan passed:/u);
}
