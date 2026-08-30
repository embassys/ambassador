import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  type FakeConnectorGateway,
  type FakeGatewayMessage,
  type FakeProviderInvocation,
  type FakeProviderSpawnRecord,
  type FakeProviderStep,
  type ProviderCancelRequest,
  type ProviderCancelResult,
  type ProviderRecoverRequest,
  type ProviderResumeRequest,
  type ProviderStartRequest,
  type ScriptedFakeProvider,
  startFakeConnectorGateway,
  startScriptedFakeProvider,
} from "./index.js";

export const K02_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

export type K02Policy = "read-only" | "workspace-write";
export type K02Platform = "linux" | "darwin";
export type K02ProviderStep =
  | FakeProviderStep
  | { kind: "cancelled_safe_wait" }
  | {
      kind: "malformed_for_execution";
      value: Readonly<Record<string, unknown>>;
    };
export interface K02ProviderSpawnRecord extends FakeProviderSpawnRecord {
  readonly stdin: "ignore";
}
export type K02CrashBarrier =
  | "binding_published"
  | "turn_published"
  | "provider_terminal_received"
  | "reply_committed_unobserved"
  | "reply_accepted"
  | "completion_accepted"
  | "outcome_observed"
  | "ack_accepted";
export type K02StateFaultBarrier =
  | "session_bound"
  | "turn_bound"
  | "first_progress"
  | "approval_required"
  | "terminal_plan";
export type K02RecoveryStateCrash =
  | "session_binding"
  | "approval_wait"
  | "uncertain"
  | "outcome_open";
export type K02StateInitializationBarrier =
  | "before_owner_flag"
  | "after_owner_flag"
  | "before_correlation_create"
  | "after_correlation_create";
export type K02RetirementBarrier =
  | { kind: "marker_created" }
  | { kind: "marker_prefix"; bytes: number }
  | { kind: "marker_final_write" }
  | { kind: "marker_file_sync" }
  | { kind: "marker_directory_sync" }
  | { kind: "artifact_deleted"; leaf: string };

export interface K02Clock {
  nowMs(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface K02ProviderPort {
  readonly spawnRecord: FakeProviderSpawnRecord;
  readonly containmentAttempts: number;
  readonly postTerminalDeliveries: number;
  start(request: ProviderStartRequest): AsyncIterable<unknown>;
  resume(request: ProviderResumeRequest): AsyncIterable<unknown>;
  recover(request: ProviderRecoverRequest): AsyncIterable<unknown>;
  cancel(request: ProviderCancelRequest): Promise<ProviderCancelResult>;
  contain(executionId: string): Promise<boolean>;
}

export interface K02ConnectorOptions {
  providerKind: "codex" | "claude" | "gemini";
  webhookPort: number;
  webhookToken: string;
  workingDirectory: string;
  policy: K02Policy;
  gatewayEndpoint: string;
  stateDirectory: string;
  provider: K02ProviderPort;
  providerProcessObserver?: {
    executable: string;
    arguments: readonly string[];
    inheritedEnvironment: Readonly<Record<string, string | undefined>>;
    webhookTokenEnvironmentName: string;
    observe(record: K02ProviderSpawnRecord): void;
  };
  clock?: K02Clock;
  crashAfter?: K02CrashBarrier;
  failStateAfter?: K02StateFaultBarrier;
  failPairedStateWriteAfter?: "conversation_update";
  crashAtUnboundState?: "turn_running" | "waiting_for_approval";
  crashAfterCancellation?: boolean;
  crashAfterLostReplyUncertain?: boolean;
  crashForRecoveryState?: K02RecoveryStateCrash;
  crashAfterReceived?: boolean;
  crashAfterTurnStarting?: boolean;
  proveNoProviderDispatch?: boolean;
  stallWebhookResponseAfterCommit?: boolean;
}

export interface K02ConnectorHandle {
  readonly webhookUrl: string;
  close(): Promise<void>;
  shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void>;
  crash(): Promise<void>;
  waitForIdle(): Promise<void>;
  inspectAdmissionStateForTest(): {
    queuedIds: readonly string[];
    activeIds: readonly string[];
    replayEntries: number;
  };
}

export interface K02ProductionModule {
  readonly CONNECTOR_LIMITS: {
    activeTurnsPerConversation: 1;
    activeTurnsGlobal: 2;
    waitingWakeIds: 100;
    acceptedWebhookSockets: 32;
    parsedWebhookRequests: 16;
    webhookRequestLineBytes: 2_048;
    webhookHeaderBytes: 16_384;
    webhookBodyBytes: 1_048_576;
    webhookHeaderDeadlineMs: 2_000;
    webhookRequestDeadlineMs: 5_000;
    gatewayMcpDeadlineMs: 35_000;
    providerDeadlineMs: 900_000;
    cancellationGraceMs: 10_000;
    containmentCleanupMs: 3_000;
    normalizedEvents: 10_000;
    providerOutputBytes: 8_388_608;
    providerIdBytes: 1_024;
    finalReplyBytes: 262_144;
  };
  startConnectorFoundation(options: K02ConnectorOptions): Promise<K02ConnectorHandle>;
  buildProviderChildEnvironment(
    platform: K02Platform,
    inherited: Readonly<Record<string, string | undefined>>,
    webhookTokenEnvironmentName: string,
  ): Record<string, string>;
  enforcePolicyCeiling(maximum: K02Policy, effective: K02Policy): K02Policy;
  consumeProviderOutput(
    stream: "stdout" | "stderr",
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<number>;
  inspectConnectorStateForTest(stateDirectory: string): {
    correlationPragmas: Readonly<Record<string, string | number>>;
    ownerPragmas: Readonly<Record<string, string | number>>;
    ownerSchemaSha256: string;
    ownerGuard: { singleton: number; ever_initialized: number };
  };
  parseConnectorArgumentsForTest(arguments_: readonly string[]): Readonly<Record<string, unknown>>;
  initializeConnectorStateForTest(options: {
    stateDirectory: string;
    webhookToken: string;
    providerKind: "codex" | "claude" | "gemini";
    workingDirectory: string;
    filesystemQualification?: "proven_local" | "network" | "unproven";
    crashAfter?: K02StateInitializationBarrier;
  }): Promise<void>;
  seedConnectorConversationsForTest(options: {
    stateDirectory: string;
    webhookToken: string;
    providerKind: "codex" | "claude" | "gemini";
    workingDirectory: string;
    count: number;
    activeConversationId: string;
    activeProviderSessionId: string;
  }): Promise<void>;
  retireConnectorStateForTest(options: {
    stateDirectory: string;
    providerKind: "codex" | "claude" | "gemini";
    arguments: readonly string[];
    crashAfter?: K02RetirementBarrier;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface K02Scenario {
  readonly module: K02ProductionModule;
  readonly connector: K02ConnectorHandle;
  readonly gateway: FakeConnectorGateway;
  readonly provider: ScriptedFakeProvider;
  readonly providerPort: K02ProviderPort;
  readonly rootDirectory: string;
  readonly stateDirectory: string;
  readonly workingDirectory: string;
  readonly observedSpawns: readonly K02ProviderSpawnRecord[];
  readonly gatewayProxy: K02GatewayFaultProxy | undefined;
  enqueue(message: FakeGatewayMessage): void;
  wake(messageId: string, timestampSeconds?: number): Promise<Response>;
  releaseProviderEvent(event: string): void;
  releaseContainment(): void;
  restart(
    scripts: readonly (readonly K02ProviderStep[])[],
    options?: {
      contained?: boolean;
      crashAfter?: K02CrashBarrier;
      webhookToken?: string;
      workingDirectory?: string;
      providerKind?: "codex" | "claude" | "gemini";
      crashForRecoveryState?: K02RecoveryStateCrash;
      proveNoProviderDispatch?: boolean;
      cancelResult?: unknown;
    },
  ): Promise<{
    connector: K02ConnectorHandle;
    provider: ScriptedFakeProvider;
    providerPort: K02ProviderPort;
  }>;
}

export type K02GatewayFault =
  | { kind: "drop_before_dispatch" }
  | { kind: "drop_after_commit" }
  | { kind: "application_error"; code: string; retryAfterMs?: unknown }
  | { kind: "malformed_result" }
  | { kind: "structured_result"; value: Readonly<Record<string, unknown>> }
  | { kind: "hold" };

export interface K02GatewayProxyCall {
  method: string | undefined;
  tool: string | undefined;
  atMs: number;
  arguments: Readonly<Record<string, unknown>> | undefined;
}

export class K02GatewayFaultProxy {
  readonly #server: HttpServer;
  readonly #faults = new Map<string, K02GatewayFault[]>();
  readonly #held = new Map<string, (() => void)[]>();
  readonly #calls: K02GatewayProxyCall[] = [];
  #endpoint: string | undefined;

  constructor(private readonly upstream: string) {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get endpoint(): string {
    assert.ok(this.#endpoint !== undefined);
    return this.#endpoint;
  }

  get calls(): readonly K02GatewayProxyCall[] {
    return this.#calls.map((call) => ({ ...call }));
  }

  failNext(tool: string, fault: K02GatewayFault): void {
    const queue = this.#faults.get(tool) ?? [];
    queue.push(fault);
    this.#faults.set(tool, queue);
  }

  release(tool: string): void {
    for (const release of this.#held.get(tool) ?? []) release();
    this.#held.delete(tool);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    assert.ok(address !== null && typeof address === "object");
    this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    let parsed: {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown; arguments?: unknown };
    } = {};
    try {
      parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
    } catch {
      // The upstream fixture owns malformed-request handling.
    }
    const tool = typeof parsed.params?.name === "string" ? parsed.params.name : undefined;
    const arguments_ = parsed.params?.arguments;
    this.#calls.push({
      method: typeof parsed.method === "string" ? parsed.method : undefined,
      tool,
      atMs: Date.now(),
      arguments:
        arguments_ !== null && typeof arguments_ === "object" && !Array.isArray(arguments_)
          ? structuredClone(arguments_ as Record<string, unknown>)
          : undefined,
    });
    const fault = tool === undefined ? undefined : this.#faults.get(tool)?.shift();
    if (fault?.kind === "drop_before_dispatch") {
      response.destroy();
      return;
    }
    if (fault?.kind === "application_error") {
      const bytes = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32_000,
            message: "fixture_tool_error",
            data: {
              code: fault.code,
              ...(fault.retryAfterMs === undefined ? {} : { retry_after_ms: fault.retryAfterMs }),
            },
          },
        }),
      );
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": "application/json",
      });
      response.end(bytes);
      return;
    }
    if (fault?.kind === "malformed_result") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"jsonrpc":"2.0","id":null,"result":{"unknown":true}}');
      return;
    }
    if (fault?.kind === "structured_result") {
      const bytes = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fault.value }),
      );
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": "application/json",
      });
      response.end(bytes);
      return;
    }
    if (fault?.kind === "hold" && tool !== undefined) {
      await new Promise<void>((resolve) => {
        const held = this.#held.get(tool) ?? [];
        held.push(resolve);
        this.#held.set(tool, held);
      });
    }
    const upstream = new URL(this.upstream);
    const headers: Record<string, string> = {
      authorization: request.headers.authorization ?? "",
      "content-type": request.headers["content-type"] ?? "application/json",
      host: upstream.host,
    };
    const session = request.headers["mcp-session-id"];
    if (typeof session === "string") headers["mcp-session-id"] = session;
    const upstreamResponse = await fetch(this.upstream, {
      method: "POST",
      headers,
      body,
    });
    await upstreamResponse.arrayBuffer().then((value) => {
      if (fault?.kind === "drop_after_commit") {
        response.destroy();
        return;
      }
      const bytes = Buffer.from(value);
      const responseHeaders: Record<string, string> = {
        "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
      };
      const responseSession = upstreamResponse.headers.get("mcp-session-id");
      if (responseSession !== null) responseHeaders["mcp-session-id"] = responseSession;
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(bytes);
    });
  }
}

export function k02Message(
  id: string,
  conversationId: string,
  text = "K02 bounded untrusted input",
  inReplyToMessageId: string | null = null,
): FakeGatewayMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_agent_id: "fixture_sender",
    message_type: "conversation_turn",
    in_reply_to_message_id: inReplyToMessageId,
    payload: { text },
    created_at: "2026-08-30T12:00:00.000Z",
  };
}

export function k02ApprovalControlArguments(
  validStartArguments: readonly string[],
): readonly (readonly string[])[] {
  return [
    ["approve", "--id=approval_1"],
    ["grant", "--approval=approval_1"],
    [...validStartArguments, "--auto-approve=true"],
  ];
}

export function k02WakeBody(messageId: string): string {
  return JSON.stringify({
    message: `A2A message ${messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
    name: "A2A Gateway",
    deliver: false,
    wakeMode: "now",
  });
}

export function k02WakeHeaders(
  webhookUrl: string,
  messageId: string,
  timestampSeconds: number,
  body = k02WakeBody(messageId),
): Record<string, string> {
  const timestamp = String(timestampSeconds);
  const signature = createHmac("sha256", K02_TOKEN)
    .update(timestamp, "ascii")
    .update(".", "ascii")
    .update(body, "utf8")
    .digest("hex");
  return {
    Host: new URL(webhookUrl).host,
    Authorization: `Bearer ${K02_TOKEN}`,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "Idempotency-Key": messageId,
    "X-Request-ID": messageId,
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature-V2": signature,
  };
}

export function k02RawHead(requestLine: string, headers: Readonly<Record<string, string>>): string {
  return `${requestLine}\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n")}\r\n\r\n`;
}

let rawSocketSetupTail = Promise.resolve();

export async function openK02Socket(webhookUrl: string): Promise<Socket> {
  const predecessor = rawSocketSetupTail;
  let release: (() => void) | undefined;
  rawSocketSetupTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    const url = new URL(webhookUrl);
    const socket = connect({ host: "127.0.0.1", port: Number(url.port) });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return socket;
  } finally {
    release?.();
  }
}

export async function readK02Response(socket: Socket, timeoutMs = 7_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for K02 raw response"));
    }, timeoutMs);
    timer.unref();
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(Buffer.concat(chunks));
      else reject(error);
    });
  });
}

export function k02ResponseStatus(response: Buffer): number | undefined {
  const match = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(response.toString("utf8"));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export class ManualK02Clock implements K02Clock {
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  #nextTimer = 1;

  constructor(private currentMs: number) {}

  nowMs(): number {
    return this.currentMs;
  }

  setTimer(callback: () => void, delayMs: number): number {
    assert.ok(Number.isSafeInteger(delayMs) && delayMs >= 0);
    const timer = this.#nextTimer;
    this.#nextTimer += 1;
    this.#timers.set(timer, { at: this.currentMs + delayMs, callback });
    return timer;
  }

  clearTimer(timer: unknown): void {
    if (typeof timer === "number") this.#timers.delete(timer);
  }

  pendingTimerCountForTest(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    assert.ok(Number.isSafeInteger(ms) && ms >= 0);
    this.currentMs += ms;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, value]) => value.at <= this.currentMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) return;
      this.#timers.delete(next[0]);
      next[1].callback();
    }
  }

  set(ms: number): void {
    assert.ok(Number.isSafeInteger(ms) && ms >= 0);
    this.currentMs = ms;
  }
}

class ScriptQueueProviderPort implements K02ProviderPort {
  readonly #scripts: K02ProviderStep[][];
  readonly #eventGates = new Map<string, { promise: Promise<void>; release: () => void }[]>();
  readonly #containmentGate: { promise: Promise<void>; release: () => void } | undefined;
  containmentAttempts = 0;
  postTerminalDeliveries = 0;

  constructor(
    private readonly provider: ScriptedFakeProvider,
    scripts: readonly (readonly K02ProviderStep[])[],
    private readonly contained: boolean,
    gatedEvents: readonly string[],
    private readonly postTerminalEvent: unknown | undefined,
    gateContainment: boolean,
    private readonly cancelResult: unknown | undefined,
  ) {
    this.#scripts = scripts.map((script) => [...script]);
    for (const event of gatedEvents) {
      let release: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      assert.ok(release !== undefined);
      const gates = this.#eventGates.get(event) ?? [];
      gates.push({ promise, release });
      this.#eventGates.set(event, gates);
    }
    if (gateContainment) {
      let release: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      assert.ok(release !== undefined);
      this.#containmentGate = { promise, release };
    }
  }

  get spawnRecord(): FakeProviderSpawnRecord {
    return this.provider.spawnRecord;
  }

  start(request: ProviderStartRequest): AsyncIterable<unknown> {
    return this.#gated(this.provider.invoke(request, this.#takeScript(request.execution_id)));
  }

  resume(request: ProviderResumeRequest): AsyncIterable<unknown> {
    return this.#gated(this.provider.invoke(request, this.#takeScript(request.execution_id)));
  }

  recover(request: ProviderRecoverRequest): AsyncIterable<unknown> {
    return this.#gated(this.provider.invoke(request, this.#takeScript(request.execution_id)));
  }

  async cancel(request: ProviderCancelRequest): Promise<ProviderCancelResult> {
    if (this.cancelResult !== undefined) {
      await this.provider.cancel(request);
      return this.cancelResult as ProviderCancelResult;
    }
    return await this.provider.cancel(request);
  }

  async contain(_executionId: string): Promise<boolean> {
    this.containmentAttempts += 1;
    await this.#containmentGate?.promise;
    return this.contained;
  }

  release(event: string): void {
    const gates = this.#eventGates.get(event);
    const gate = gates?.shift();
    assert.ok(gate !== undefined, `K02 provider event ${event} is not gated`);
    if (gates?.length === 0) this.#eventGates.delete(event);
    gate.release();
  }

  releaseContainment(): void {
    assert.ok(this.#containmentGate !== undefined, "K02 containment is not gated");
    this.#containmentGate.release();
  }

  async *#gated(invocation: FakeProviderInvocation): AsyncIterableIterator<unknown> {
    for await (const event of invocation) {
      if (event !== null && typeof event === "object" && !Array.isArray(event)) {
        const eventName = (event as { event?: unknown }).event;
        if (typeof eventName === "string") await this.#eventGates.get(eventName)?.[0]?.promise;
      }
      yield event;
      if (this.postTerminalEvent !== undefined && isProviderTerminalEvent(event)) {
        this.postTerminalDeliveries += 1;
        yield this.postTerminalEvent;
      }
    }
  }

  #takeScript(executionId: string): FakeProviderStep[] {
    const script = this.#scripts.shift();
    assert.ok(script !== undefined, "K02 fake provider script queue exhausted");
    return script.map((step) =>
      step.kind === "cancelled_safe_wait"
        ? {
            kind: "malformed",
            value: {
              event: "cancelled",
              execution_id: executionId,
              reason_code: "cancelled_during_safe_wait",
            },
          }
        : step.kind === "malformed_for_execution"
          ? {
              kind: "malformed",
              value: { ...step.value, execution_id: executionId },
            }
          : step,
    );
  }
}

function isProviderTerminalEvent(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = (value as { event?: unknown }).event;
  return (
    event === "reply" ||
    event === "completed_without_reply" ||
    event === "unsupported" ||
    event === "failed" ||
    event === "cancelled" ||
    event === "uncertain"
  );
}

export function isExactMissingK03Entry(error: unknown, moduleUrl: URL): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; url?: unknown };
  if (candidate.code !== "ERR_MODULE_NOT_FOUND") return false;
  if (candidate.url === moduleUrl.href) return true;
  if (typeof candidate.message !== "string") return false;
  const exactMissing = `Cannot find module '${moduleUrl.pathname}'`;
  const exactMissingUrl = `Cannot find module '${moduleUrl.href}'`;
  return (
    candidate.message.startsWith(exactMissing) || candidate.message.startsWith(exactMissingUrl)
  );
}

export function validateK02ProductionModule(loaded: unknown): K02ProductionModule {
  if (loaded === null || typeof loaded !== "object") {
    throw new TypeError("K03 connector entry loaded a non-module value");
  }
  const module = loaded as Partial<K02ProductionModule>;
  if (
    typeof module.startConnectorFoundation !== "function" ||
    typeof module.buildProviderChildEnvironment !== "function" ||
    typeof module.enforcePolicyCeiling !== "function" ||
    typeof module.consumeProviderOutput !== "function" ||
    typeof module.inspectConnectorStateForTest !== "function" ||
    typeof module.parseConnectorArgumentsForTest !== "function" ||
    typeof module.initializeConnectorStateForTest !== "function" ||
    typeof module.seedConnectorConversationsForTest !== "function" ||
    typeof module.retireConnectorStateForTest !== "function" ||
    module.CONNECTOR_LIMITS === undefined
  ) {
    throw new TypeError("K03 connector entry is missing its reviewed foundation exports");
  }
  return module as K02ProductionModule;
}

export async function loadK02Production(caseId: string): Promise<K02ProductionModule> {
  const url = new URL("../../../packages/connector-core/src/index.js", import.meta.url);
  let loaded: unknown;
  try {
    loaded = await import(url.href);
  } catch (error) {
    if (!isExactMissingK03Entry(error, url)) throw error;
    throw new Error(`[${caseId}] K03 provider-neutral connector production boundary is absent`);
  }
  return validateK02ProductionModule(loaded);
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
  assert.ok(port >= 1024 && port <= 65_535 && port !== 8787);
  return port;
}

export async function startK02Scenario(
  t: TestContext,
  caseId: string,
  options: {
    scripts?: readonly (readonly K02ProviderStep[])[];
    contained?: boolean;
    clock?: K02Clock;
    crashAfter?: K02CrashBarrier;
    failStateAfter?: K02StateFaultBarrier;
    failPairedStateWriteAfter?: "conversation_update";
    crashAtUnboundState?: "turn_running" | "waiting_for_approval";
    crashAfterCancellation?: boolean;
    crashAfterLostReplyUncertain?: boolean;
    crashForRecoveryState?: K02RecoveryStateCrash;
    crashAfterReceived?: boolean;
    crashAfterTurnStarting?: boolean;
    proveNoProviderDispatch?: boolean;
    stallWebhookResponseAfterCommit?: boolean;
    policy?: K02Policy;
    gatedEvents?: readonly string[];
    gatewayProxy?: boolean;
    gateContainment?: boolean;
    postTerminalEvent?: unknown;
    cancelResult?: unknown;
    webhookTokenEnvironmentName?: string;
    inheritedProviderEnvironment?: Readonly<Record<string, string | undefined>>;
    stateDirectory?: string;
    workingDirectory?: string;
  } = {},
): Promise<K02Scenario> {
  const connectorsForCleanup: K02ConnectorHandle[] = [];
  t.after(async () => {
    for (const handle of connectorsForCleanup.reverse()) await handle.close();
  });
  const root = await mkdtemp(join(tmpdir(), "a2a-k02-"));
  const stateDirectory = options.stateDirectory ?? join(root, "state");
  const workingDirectory = options.workingDirectory ?? join(root, "workspace");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
  const gatewayProxy = options.gatewayProxy
    ? new K02GatewayFaultProxy(gateway.endpoint)
    : undefined;
  if (gatewayProxy !== undefined) {
    await gatewayProxy.listen();
    t.after(async () => await gatewayProxy.close());
  }
  const provider = await startScriptedFakeProvider(t);
  const providerPort = new ScriptQueueProviderPort(
    provider,
    options.scripts ?? [
      [
        { kind: "session", provider_session_id: "session_1" },
        { kind: "reply", text: "reply" },
      ],
    ],
    options.contained ?? true,
    options.gatedEvents ?? [],
    options.postTerminalEvent,
    options.gateContainment ?? false,
    options.cancelResult,
  );
  const module = await loadK02Production(caseId);
  const observedSpawns: K02ProviderSpawnRecord[] = [];
  const connector = await module.startConnectorFoundation({
    providerKind: "codex",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory,
    policy: options.policy ?? "read-only",
    gatewayEndpoint: gatewayProxy?.endpoint ?? gateway.endpoint,
    stateDirectory,
    provider: providerPort,
    providerProcessObserver: {
      executable: process.execPath,
      arguments: ["fixture-provider-port"],
      inheritedEnvironment: options.inheritedProviderEnvironment ?? process.env,
      webhookTokenEnvironmentName: options.webhookTokenEnvironmentName ?? "K02_WEBHOOK_TOKEN",
      observe(record) {
        observedSpawns.push(structuredClone(record));
      },
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.crashAfter === undefined ? {} : { crashAfter: options.crashAfter }),
    ...(options.failStateAfter === undefined ? {} : { failStateAfter: options.failStateAfter }),
    ...(options.failPairedStateWriteAfter === undefined
      ? {}
      : { failPairedStateWriteAfter: options.failPairedStateWriteAfter }),
    ...(options.crashAtUnboundState === undefined
      ? {}
      : { crashAtUnboundState: options.crashAtUnboundState }),
    ...(options.crashAfterCancellation === undefined
      ? {}
      : { crashAfterCancellation: options.crashAfterCancellation }),
    ...(options.crashAfterLostReplyUncertain === undefined
      ? {}
      : { crashAfterLostReplyUncertain: options.crashAfterLostReplyUncertain }),
    ...(options.crashForRecoveryState === undefined
      ? {}
      : { crashForRecoveryState: options.crashForRecoveryState }),
    ...(options.crashAfterReceived === undefined
      ? {}
      : { crashAfterReceived: options.crashAfterReceived }),
    ...(options.crashAfterTurnStarting === undefined
      ? {}
      : { crashAfterTurnStarting: options.crashAfterTurnStarting }),
    ...(options.proveNoProviderDispatch === undefined
      ? {}
      : { proveNoProviderDispatch: options.proveNoProviderDispatch }),
    ...(options.stallWebhookResponseAfterCommit === undefined
      ? {}
      : { stallWebhookResponseAfterCommit: options.stallWebhookResponseAfterCommit }),
  });
  connectorsForCleanup.push(connector);
  const webhookPort = Number(new URL(connector.webhookUrl).port);
  return {
    module,
    connector,
    gateway,
    provider,
    providerPort,
    rootDirectory: root,
    stateDirectory,
    workingDirectory,
    get observedSpawns() {
      return observedSpawns.map((record) => structuredClone(record));
    },
    gatewayProxy,
    enqueue(message) {
      gateway.enqueueMessage(message);
    },
    async wake(messageId, timestampSeconds) {
      const effectiveTimestamp =
        timestampSeconds ??
        (options.clock === undefined ? undefined : Math.floor(options.clock.nowMs() / 1_000));
      return await gateway.sendWake(
        connector.webhookUrl,
        messageId,
        effectiveTimestamp === undefined ? {} : { timestampSeconds: effectiveTimestamp },
      );
    },
    releaseProviderEvent(event) {
      providerPort.release(event);
    },
    releaseContainment() {
      providerPort.releaseContainment();
    },
    async restart(scripts, restartOptions = {}) {
      const restartedProvider = await startScriptedFakeProvider(t);
      const restartedProviderPort = new ScriptQueueProviderPort(
        restartedProvider,
        scripts,
        restartOptions.contained ?? true,
        [],
        undefined,
        false,
        restartOptions.cancelResult,
      );
      const restartedConnector = await module.startConnectorFoundation({
        providerKind: restartOptions.providerKind ?? "codex",
        webhookPort,
        webhookToken: restartOptions.webhookToken ?? K02_TOKEN,
        workingDirectory: restartOptions.workingDirectory ?? workingDirectory,
        policy: options.policy ?? "read-only",
        gatewayEndpoint: gatewayProxy?.endpoint ?? gateway.endpoint,
        stateDirectory,
        provider: restartedProviderPort,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(restartOptions.crashAfter === undefined
          ? {}
          : { crashAfter: restartOptions.crashAfter }),
        ...(restartOptions.crashForRecoveryState === undefined
          ? {}
          : { crashForRecoveryState: restartOptions.crashForRecoveryState }),
        ...(restartOptions.proveNoProviderDispatch === undefined
          ? {}
          : { proveNoProviderDispatch: restartOptions.proveNoProviderDispatch }),
      });
      connectorsForCleanup.push(restartedConnector);
      return {
        connector: restartedConnector,
        provider: restartedProvider,
        providerPort: restartedProviderPort,
      };
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
