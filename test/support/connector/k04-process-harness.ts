import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import Database from "better-sqlite3";

import { type FakeCentral, startFakeCentral } from "../fake-central.js";
import { TestMcpClient } from "../mcp-client.js";
import {
  startV2ManagedProcess,
  type V2ManagedProcess,
  v2NodeProcessEnvironment,
} from "../v2-process-runtime.js";
import {
  K04_CONTENT_PREFIX,
  K04_EMAIL,
  K04_INBOUND_TEXT,
  K04_USERNAME,
  K04_VERIFICATION_CODE,
  K04_WEBHOOK_TOKEN,
} from "./k04-constants.js";

export {
  K04_CONTENT_PREFIX,
  K04_EMAIL,
  K04_REPLY_TEXT,
  K04_USERNAME,
  K04_VERIFICATION_CODE,
  K04_WEBHOOK_TOKEN,
} from "./k04-constants.js";

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
  readonly providerSessionId: string;
  readonly providerTurnId: string | null;
}

export type K04ConnectorCrashBarrier =
  | "binding_published"
  | "turn_published"
  | "provider_terminal_received"
  | "reply_accepted";

export interface K04ConnectorControl {
  providerRequests(): readonly K04ProviderRequestRecord[];
  providerSpawnSha256(): string;
  fatalCode(): string | undefined;
  waitForProviderSpawnProof(): Promise<void>;
  waitForProviderRequests(count: number): Promise<void>;
  waitForProviderBarriers(count: number): Promise<void>;
  waitForCrashBarrier(barrier: K04ConnectorCrashBarrier): Promise<void>;
  waitForIdle(): Promise<void>;
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
  completionRequests(): readonly {
    outcome: "failed";
    reasonCode: "provider_start_failed";
  }[];
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
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
  let providerSpawnSha256: string | undefined;
  let fatalCode: string | undefined;
  let idleRequestSequence = 0;
  const crashBarriers = new Set<K04ConnectorCrashBarrier>();
  const idleSequences = new Set<number>();
  let protocolError: Error | undefined;
  const boundaryWaiters = new Set<{
    readonly ready: () => boolean;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  const settleWaiters = (): void => {
    for (const waiter of boundaryWaiters) {
      if (protocolError === undefined && !waiter.ready()) continue;
      clearTimeout(waiter.timer);
      boundaryWaiters.delete(waiter);
      if (protocolError === undefined) waiter.resolve();
      else waiter.reject(protocolError);
    }
  };
  const failProtocol = (detail: string): void => {
    protocolError ??= new Error(`K04 connector IPC protocol violation: ${detail}`);
    settleWaiters();
  };
  process.child.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== "k04") return;
    if (
      hasExactKeys(message, ["channel", "event", "code"]) &&
      message.event === "fatal" &&
      typeof message.code === "string" &&
      /^(?:connector_[a-z_]+|unexpected)$/u.test(message.code)
    ) {
      if (fatalCode !== undefined) {
        failProtocol("duplicate fatal observation");
        return;
      }
      fatalCode = message.code;
      settleWaiters();
      return;
    }
    if (
      hasExactKeys(message, ["channel", "event", "sha256"]) &&
      message.event === "provider_spawn"
    ) {
      if (
        providerSpawnSha256 !== undefined ||
        typeof message.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(message.sha256)
      ) {
        failProtocol("invalid provider spawn proof");
        return;
      }
      providerSpawnSha256 = message.sha256;
      settleWaiters();
      return;
    }
    if (
      hasExactKeys(message, ["channel", "event", "name", "sequence"]) &&
      message.event === "provider_barrier" &&
      message.name === "reply" &&
      Number.isSafeInteger(message.sequence) &&
      message.sequence === barrierCount + 1
    ) {
      barrierCount += 1;
      settleWaiters();
      return;
    }
    if (
      hasExactKeys(message, ["channel", "event", "name", "sequence"]) &&
      message.event === "crash_barrier" &&
      [
        "binding_published",
        "turn_published",
        "provider_terminal_received",
        "reply_accepted",
      ].includes(String(message.name)) &&
      message.sequence === 1
    ) {
      const name = message.name as K04ConnectorCrashBarrier;
      if (crashBarriers.has(name)) {
        failProtocol("duplicate crash barrier");
        return;
      }
      crashBarriers.add(name);
      settleWaiters();
      return;
    }
    if (
      hasExactKeys(message, ["channel", "event", "sequence"]) &&
      message.event === "idle" &&
      Number.isSafeInteger(message.sequence) &&
      (message.sequence as number) >= 1
    ) {
      const sequence = message.sequence as number;
      if (idleSequences.has(sequence) || sequence > idleRequestSequence) {
        failProtocol("invalid idle observation");
        return;
      }
      idleSequences.add(sequence);
      settleWaiters();
      return;
    }
    if (
      hasExactKeys(message, [
        "channel",
        "event",
        "kind",
        "conversation_id",
        "message_id",
        "provider_session_id",
        "provider_turn_id",
      ]) &&
      message.event === "provider_request" &&
      ["start", "resume", "recover"].includes(String(message.kind)) &&
      typeof message.conversation_id === "string" &&
      ID.test(message.conversation_id) &&
      typeof message.message_id === "string" &&
      ID.test(message.message_id) &&
      typeof message.provider_session_id === "string" &&
      (typeof message.provider_turn_id === "string" || message.provider_turn_id === null) &&
      ID.test(message.provider_session_id) &&
      (message.provider_turn_id === null || ID.test(message.provider_turn_id)) &&
      (message.kind === "recover"
        ? message.provider_turn_id !== null
        : message.provider_turn_id === null)
    ) {
      records.push({
        kind: message.kind as K04ProviderRequestRecord["kind"],
        conversationId: message.conversation_id,
        messageId: message.message_id,
        providerSessionId: message.provider_session_id,
        providerTurnId: message.provider_turn_id,
      });
      settleWaiters();
      return;
    }
    failProtocol("unexpected message shape");
  });
  const assertProtocol = (): void => {
    if (protocolError !== undefined) throw protocolError;
  };
  const boundedWait = async (ready: () => boolean): Promise<void> => {
    assertProtocol();
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        ready,
        resolve,
        reject,
        timer: setTimeout(() => {
          boundaryWaiters.delete(waiter);
          reject(new Error("K04 child did not reach its content-free IPC boundary"));
        }, 10_000),
      };
      waiter.timer.unref();
      boundaryWaiters.add(waiter);
    });
  };
  return {
    providerRequests: () => {
      assertProtocol();
      return records.map((record) => ({ ...record }));
    },
    providerSpawnSha256: () => {
      assertProtocol();
      assert.ok(providerSpawnSha256 !== undefined, "K04 provider spawn proof is unavailable");
      return providerSpawnSha256;
    },
    fatalCode: () => {
      assertProtocol();
      return fatalCode;
    },
    waitForProviderSpawnProof: async () => {
      await boundedWait(() => providerSpawnSha256 !== undefined);
    },
    waitForProviderRequests: async (count) => {
      assert.ok(Number.isSafeInteger(count) && count >= 1);
      await boundedWait(() => records.length >= count);
    },
    waitForProviderBarriers: async (count) => {
      assert.ok(Number.isSafeInteger(count) && count >= 1);
      await boundedWait(() => barrierCount >= count);
    },
    waitForCrashBarrier: async (barrier) => {
      await boundedWait(() => crashBarriers.has(barrier));
    },
    waitForIdle: async () => {
      idleRequestSequence += 1;
      const sequence = idleRequestSequence;
      await new Promise<void>((resolve, reject) => {
        process.child.send(
          { channel: "k04_control", command: "wait_for_idle", sequence },
          (error) => (error === null ? resolve() : reject(error)),
        );
      });
      await boundedWait(() => idleSequences.has(sequence));
    },
    releaseProviderBarrier: () => {
      assertProtocol();
      process.child.send({ channel: "k04_control", command: "release_provider_barrier" });
    },
  };
}

function expectedK04ProviderSpawnSha256(): string {
  const canonical = JSON.stringify({
    executable: process.execPath,
    arguments: [
      join(process.cwd(), ".test-dist", "test", "support", "connector", "fake-provider-worker.js"),
    ],
    environment: {},
    shell: false,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function gatewayControl(process: V2ManagedProcess): K04GatewayControl {
  const operations: K04GatewayOperation[] = [];
  const completionRequests: Array<{
    outcome: "failed";
    reasonCode: "provider_start_failed";
  }> = [];
  const arrivals = new Map<K04GatewayFetchBarrier, number[]>();
  const arrivedBarriers = new Set<K04GatewayFetchBarrier>();
  const waiters = new Map<
    K04GatewayFetchBarrier,
    Array<{ readonly resolve: () => void; readonly reject: (error: Error) => void }>
  >();
  const releasable = new Map<K04GatewayFetchBarrier, number[]>();
  let protocolError: Error | undefined;
  const assertProtocol = (): void => {
    if (protocolError !== undefined) throw protocolError;
  };
  const failProtocol = (detail: string): void => {
    protocolError ??= new Error(`K04 gateway IPC protocol violation: ${detail}`);
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(protocolError);
    }
    waiters.clear();
  };
  process.child.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== "k04_gateway_fetch") return;
    if (
      hasExactKeys(message, ["channel", "event", "operation"]) &&
      message.event === "request" &&
      ["receive", "wake", "reply", "complete", "outcome", "ack"].includes(String(message.operation))
    ) {
      operations.push(message.operation as K04GatewayOperation);
      return;
    }
    if (
      hasExactKeys(message, ["channel", "event", "outcome", "reason_code"]) &&
      message.event === "completion_request" &&
      message.outcome === "failed" &&
      message.reason_code === "provider_start_failed"
    ) {
      completionRequests.push({ outcome: message.outcome, reasonCode: message.reason_code });
      return;
    }
    if (
      !hasExactKeys(message, ["channel", "event", "barrier", "sequence"]) ||
      message.event !== "barrier" ||
      ![
        "receive_selected",
        "wake_before_request",
        "reply_accepted_unobserved",
        "ack_accepted_unobserved",
      ].includes(String(message.barrier)) ||
      message.sequence !== 1
    ) {
      failProtocol("unexpected message shape");
      return;
    }
    const barrier = message.barrier as K04GatewayFetchBarrier;
    const sequence = message.sequence as number;
    if (arrivedBarriers.has(barrier)) {
      failProtocol("duplicate fetch barrier");
      return;
    }
    arrivedBarriers.add(barrier);
    const waiter = waiters.get(barrier)?.shift();
    if (waiter !== undefined) {
      const ready = releasable.get(barrier) ?? [];
      ready.push(sequence);
      releasable.set(barrier, ready);
      waiter.resolve();
      return;
    }
    const queued = arrivals.get(barrier) ?? [];
    queued.push(sequence);
    arrivals.set(barrier, queued);
  });
  return {
    operations: () => {
      assertProtocol();
      return [...operations];
    },
    completionRequests: () => {
      assertProtocol();
      return completionRequests.map((request) => ({ ...request }));
    },
    waitForFetchBarrier: async (barrier) => {
      assertProtocol();
      const queued = arrivals.get(barrier)?.shift();
      if (queued !== undefined) {
        const ready = releasable.get(barrier) ?? [];
        ready.push(queued);
        releasable.set(barrier, ready);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve: (): void => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error: Error): void => {
            clearTimeout(timer);
            reject(error);
          },
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
      assertProtocol();
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
    readonly crashBarrier?: K04ConnectorCrashBarrier;
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
      ...(options.crashBarrier === undefined ? {} : { K04_CRASH_BARRIER: options.crashBarrier }),
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
  await control.waitForProviderSpawnProof();
  assert.equal(control.providerSpawnSha256(), expectedK04ProviderSpawnSha256());
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
  await client.callTool("verify_email", { email: K04_EMAIL, code: K04_VERIFICATION_CODE });
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

export function assertK04MessageRows(fixture: K04Fixture, expected: number): void {
  const database = new Database(join(fixture.connectorStateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      database.prepare<[], { count: number }>("SELECT count(*) AS count FROM messages").get(),
      { count: expected },
    );
  } finally {
    database.close();
  }
}

export async function scanK04Artifacts(options: {
  readonly fixture: K04Fixture;
  readonly captures: readonly Capture[];
  readonly markers: readonly Marker[];
}): Promise<void> {
  const commonMarkers: readonly Marker[] = [
    { name: "common-webhook-token", value: K04_WEBHOOK_TOKEN },
    { name: "common-central-token", value: options.fixture.central.currentV2Token(K04_USERNAME) },
    { name: "common-enrollment-email", value: K04_EMAIL },
    { name: "common-enrollment-username", value: K04_USERNAME },
    { name: "common-verification-code", value: K04_VERIFICATION_CODE },
    { name: "common-content-prefix", value: K04_CONTENT_PREFIX },
  ];
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
      markers: [...commonMarkers, ...options.markers].map((marker) => ({
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
