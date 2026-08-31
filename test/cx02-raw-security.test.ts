import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startConnector, startConnectorRuntime } from "../packages/connector-core/src/connector.js";
import type { ConnectorPolicy, ProviderKind } from "../packages/connector-core/src/constants.js";
import type { ProviderPort } from "../packages/connector-core/src/runtime-types.js";
import {
  accountStateDirectory,
  type ConnectorStateReservation,
  initializeConnectorStateForTest,
  reserveConnectorState,
  retireConnectorStateForTest,
  seedConnectorConversationsForTest,
} from "../packages/connector-core/src/state.js";

import {
  CX02_EXECUTION_ID,
  CX02_THREAD_ID,
  CX02_TURN_ID,
  collectEvents,
  createCx02Adapter,
  type FakeCodexExchange,
  type FakeCodexProcessPlan,
  type FakeCodexWireWrite,
  handshakeExchanges,
  resumeRequest,
  startFakeCodexAppServer,
  startRequest,
  syntheticCx02Environment,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";
import { startFakeConnectorGateway } from "./support/connector/index.js";
import { K02_TOKEN, k02Message } from "./support/connector/k02-production.js";

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function assertLoopbackPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

type ManagedProviderForTest = ProviderPort & { close(deadlineUnixMs: number): Promise<void> };

type InternalStartConnector = (options: {
  providerKind: ProviderKind;
  webhookPort: number;
  webhookToken: string;
  workingDirectory: string;
  policy: ConnectorPolicy;
  stateReservation: ConnectorStateReservation;
  providerFactory: (options: {
    readonly workingDirectory: string;
    readonly policy: ConnectorPolicy;
  }) => Promise<ManagedProviderForTest>;
}) => ReturnType<typeof startConnector>;

const startConnectorWithProviderFactory = startConnector as unknown as InternalStartConnector;

function managedProviderForTest(
  close: (deadlineUnixMs: number) => Promise<void>,
): ManagedProviderForTest {
  const unavailable = async function* (): AsyncIterable<unknown> {};
  return {
    spawnRecord: { executable: "managed-provider", arguments: [], environment: {}, shell: false },
    containmentAttempts: 0,
    postTerminalDeliveries: 0,
    start: unavailable,
    resume: unavailable,
    recover: unavailable,
    async cancel() {
      return { status: "not_found" };
    },
    async contain() {
      return true;
    },
    close,
  };
}

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function started(cwd: string): FakeCodexExchange[] {
  return [
    ...handshakeExchanges(),
    {
      expectMethod: "thread/start",
      result: threadSettingsResponse(cwd),
      afterResponse: [
        { kind: "json", value: { method: "thread/started", params: { thread: validThread(cwd) } } },
      ],
    },
  ];
}

function completed(text = "raw-boundary reply"): unknown {
  return {
    method: "turn/completed",
    params: {
      threadId: CX02_THREAD_ID,
      turn: validTurn(CX02_TURN_ID, "completed", [
        { id: "raw_item", type: "agentMessage", phase: "final_answer", text },
      ]),
    },
  };
}

function activePlan(
  cwd: string,
  writes: readonly FakeCodexWireWrite[],
  stderrBytes?: number,
  exitAfterWrites = false,
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  return {
    kind: "app-server",
    exchanges: [
      ...started(cwd),
      {
        expectMethod: "turn/start",
        result: { turn: validTurn() },
        afterResponse: [
          {
            kind: "json",
            value: {
              method: "turn/started",
              params: { threadId: CX02_THREAD_ID, turn: validTurn() },
            },
          },
          ...writes,
        ],
        ...(exitAfterWrites ? { exitCodeAfter: 0 } : {}),
      },
    ],
    ...(stderrBytes === undefined ? {} : { stderrBytes }),
  };
}

function jsonLineBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`);
}

function stdoutBoundaryPlan(
  cwd: string,
  targetBytes: number,
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  const threadResult = threadSettingsResponse(cwd);
  const threadNotification = {
    method: "thread/started",
    params: { thread: validThread(cwd) },
  };
  const turnResult = { turn: validTurn() };
  const turnNotification = {
    method: "turn/started",
    params: { threadId: CX02_THREAD_ID, turn: validTurn() },
  };
  const terminal = completed("stdout-boundary reply");
  const fixedBytes = [
    { id: 1, result: {} },
    { id: 2, result: threadResult },
    threadNotification,
    { id: 3, result: turnResult },
    turnNotification,
    terminal,
  ].reduce<number>((total, value) => total + jsonLineBytes(value), 0);
  const emptyWarning = { method: "warning", params: { message: "" } };
  const emptyWarningBytes = jsonLineBytes(emptyWarning);
  let remaining = targetBytes - fixedBytes;
  const warnings: FakeCodexWireWrite[] = [];
  while (remaining > 0) {
    const lineBytes = Math.min(1_000_000, remaining);
    assert.ok(lineBytes >= emptyWarningBytes);
    warnings.push({
      kind: "json",
      value: {
        method: "warning",
        params: { message: "x".repeat(lineBytes - emptyWarningBytes) },
      },
    });
    remaining -= lineBytes;
  }
  return {
    kind: "app-server",
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/start",
        result: threadResult,
        afterResponse: [{ kind: "json", value: threadNotification }],
      },
      {
        expectMethod: "turn/start",
        result: turnResult,
        afterResponse: [
          { kind: "json", value: turnNotification },
          ...warnings,
          { kind: "json", value: terminal },
        ],
      },
    ],
  };
}

function utf8Write(value: string): FakeCodexWireWrite {
  return { kind: "utf8", value };
}

function jsonRecordAtBytes(method: string, targetBytes: number, depth = 1): string {
  let nested: unknown = "";
  for (let index = 2; index < depth; index += 1) nested = [nested];
  const base = {
    method,
    params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID, nested, pad: "" },
  };
  const empty = JSON.stringify(base);
  const padding = targetBytes - Buffer.byteLength(empty);
  assert.ok(padding >= 0);
  return `${JSON.stringify({ ...base, params: { ...base.params, pad: "x".repeat(padding) } })}\n`;
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const child = spawn(executable, [...arguments_], {
    cwd: process.cwd(),
    env: { ...environment },
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error("CX02 artifact command failed"));
    });
  });
}

async function runCapturedCommand(
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory = process.cwd(),
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(executable, [...arguments_], {
    cwd: workingDirectory,
    env: { ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function discoverPopulatedPnpmStore(): Promise<string> {
  const searchDirectories = [process.env.PNPM_HOME, process.cwd()].filter(
    (candidate): candidate is string => candidate !== undefined && isAbsolute(candidate),
  );
  for (const searchDirectory of searchDirectories) {
    const searchMetadata = await stat(searchDirectory).catch(() => undefined);
    if (searchMetadata === undefined || !searchMetadata.isDirectory()) continue;
    const result = await runCapturedCommand(
      "pnpm",
      ["store", "path"],
      process.env,
      searchDirectory,
    );
    if (result.code !== 0 || result.signal !== null || result.stderr !== "") continue;
    const lines = result.stdout.trimEnd().split("\n");
    if (lines.length !== 1 || !isAbsolute(lines[0] ?? "")) continue;
    const store = await realpath(lines[0] as string);
    const [storeMetadata, indexMetadata, fileShards] = await Promise.all([
      stat(store),
      stat(join(store, "index.db")),
      readdir(join(store, "files")),
    ]);
    if (storeMetadata.isDirectory() && indexMetadata.isFile() && fileShards.length > 0) {
      return store;
    }
  }
  throw new Error("CX02 populated pnpm store unavailable");
}

async function runDiagnosticWorker(request: {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly input: string;
}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const worker = fileURLToPath(
    new URL("./support/codex-app-server/adapter-diagnostic-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [worker], {
    cwd: process.cwd(),
    env: { ...syntheticCx02Environment(request.homeDirectory) },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`CX02 diagnostic worker failed: ${code}/${signal}`));
    });
  });
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test("CX02-X20 enforces UTF-8 JSONL record byte and depth boundaries before normalization", async (t) => {
  const cwd = process.cwd();
  const exactRecord = jsonRecordAtBytes("turn/diff/updated", 1_048_576);
  assert.equal(Buffer.byteLength(exactRecord) - 1, 1_048_576);
  const depth100 = jsonRecordAtBytes("turn/diff/updated", 1_024, 100);
  const cases: readonly {
    name: string;
    writes: readonly FakeCodexWireWrite[];
    accepted: boolean;
    exitAfterWrites?: boolean;
  }[] = [
    {
      name: "exact record",
      writes: [utf8Write(exactRecord), { kind: "json", value: completed() }],
      accepted: true,
    },
    {
      name: "one-over record",
      writes: [utf8Write(jsonRecordAtBytes("turn/diff/updated", 1_048_577))],
      accepted: false,
    },
    {
      name: "depth 100",
      writes: [utf8Write(depth100), { kind: "json", value: completed() }],
      accepted: true,
    },
    {
      name: "depth 101",
      writes: [utf8Write(jsonRecordAtBytes("turn/diff/updated", 1_024, 101))],
      accepted: false,
    },
    {
      name: "invalid UTF-8",
      writes: [{ kind: "base64", value: Buffer.from([0xc3, 0x28, 0x0a]).toString("base64") }],
      accepted: false,
    },
    {
      name: "duplicate key",
      writes: [utf8Write('{"method":"warning","method":"warning","params":{"message":"x"}}\n')],
      accepted: false,
    },
    {
      name: "escaped-equivalent duplicate key",
      writes: [
        utf8Write('{"method":"warning","\\u006dethod":"warning","params":{"message":"x"}}\n'),
      ],
      accepted: false,
    },
    { name: "array", writes: [utf8Write("[]\n")], accepted: false },
    {
      name: "batch",
      writes: [utf8Write('[{"method":"warning","params":{"message":"x"}}]\n')],
      accepted: false,
    },
    {
      name: "unknown method",
      writes: [utf8Write('{"method":"future/unknown","params":{}}\n')],
      accepted: false,
    },
    {
      name: "unknown control field",
      writes: [
        utf8Write('{"method":"turn/started","params":{"threadId":"x","turn":{}},"extra":true}\n'),
      ],
      accepted: false,
    },
    {
      name: "unterminated line",
      writes: [utf8Write('{"method":"warning","params":{"message":"x"}}')],
      accepted: false,
      exitAfterWrites: true,
    },
  ];
  for (const vector of cases) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X20", {
      appPlan: activePlan(cwd, vector.writes, undefined, vector.exitAfterWrites),
    });
    const terminal = (await collectEvents(adapter.start(startRequest()))).at(-1);
    assert.equal(eventName(terminal), vector.accepted ? "reply" : "uncertain", vector.name);
  }
});

test("CX02-X21 preserves every common exact limit through valid App Server envelopes", async (t) => {
  const cwd = process.cwd();
  const delta = (text: string, itemId = "limit_item") => ({
    method: "item/agentMessage/delta",
    params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID, itemId, delta: text },
  });
  const matrices: readonly {
    name: string;
    writes: readonly FakeCodexWireWrite[];
    terminal: "reply" | "failed" | "uncertain";
    stderrBytes?: number;
  }[] = [
    {
      name: "10000 normalized events",
      writes: [
        ...Array.from({ length: 9_997 }, () => ({ kind: "json" as const, value: delta("x") })),
        { kind: "json", value: completed("reply") },
      ],
      terminal: "reply",
    },
    {
      name: "10001 normalized events",
      writes: Array.from({ length: 9_999 }, () => ({ kind: "json" as const, value: delta("x") })),
      terminal: "uncertain",
    },
    {
      name: "progress exact",
      writes: [
        { kind: "json", value: delta("x".repeat(262_144)) },
        { kind: "json", value: completed() },
      ],
      terminal: "reply",
    },
    {
      name: "progress one over",
      writes: [{ kind: "json", value: delta("x".repeat(262_145)) }],
      terminal: "uncertain",
    },
    {
      name: "reply exact",
      writes: [{ kind: "json", value: completed("x".repeat(262_144)) }],
      terminal: "reply",
    },
    {
      name: "reply one over",
      writes: [{ kind: "json", value: completed("x".repeat(262_145)) }],
      terminal: "failed",
    },
    {
      name: "turn ID exact",
      writes: [{ kind: "json", value: completed("reply") }],
      terminal: "reply",
    },
    {
      name: "stderr exact",
      writes: [{ kind: "json", value: completed() }],
      stderrBytes: 8_388_608,
      terminal: "reply",
    },
    { name: "stderr one over", writes: [], stderrBytes: 8_388_609, terminal: "uncertain" },
  ];
  for (const vector of matrices) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: activePlan(cwd, vector.writes, vector.stderrBytes),
    });
    const terminal = (await collectEvents(adapter.start(startRequest()))).at(-1);
    if (vector.terminal === "failed") {
      assert.deepEqual(
        terminal,
        {
          event: "failed",
          execution_id: CX02_EXECUTION_ID,
          reason_code: "provider_result_invalid",
        },
        vector.name,
      );
    } else assert.equal(eventName(terminal), vector.terminal, vector.name);
  }

  for (const bytes of [1_024, 1_025]) {
    const turnId = "x".repeat(bytes);
    const base = activePlan(cwd, [{ kind: "json", value: completed() }]);
    const replacement: FakeCodexExchange = {
      expectMethod: "turn/start",
      result: { turn: validTurn(turnId) },
      afterResponse: [
        {
          kind: "json",
          value: {
            method: "turn/started",
            params: { threadId: CX02_THREAD_ID, turn: validTurn(turnId) },
          },
        },
        {
          kind: "json",
          value: {
            method: "turn/completed",
            params: {
              threadId: CX02_THREAD_ID,
              turn: validTurn(turnId, "completed", [
                { id: "i", type: "agentMessage", phase: "final_answer", text: "reply" },
              ]),
            },
          },
        },
      ],
    };
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      ...base,
      exchanges: base.exchanges.map((exchange, index) => (index === 3 ? replacement : exchange)),
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), bytes === 1_024 ? "reply" : "uncertain");
  }

  for (const bytes of [1_024, 1_025]) {
    const threadId = "s".repeat(bytes);
    const plan = activePlan(cwd, [{ kind: "json", value: completed("reply") }]);
    const threadExchange: FakeCodexExchange = {
      expectMethod: "thread/start",
      result: threadSettingsResponse(cwd, threadId),
      afterResponse: [
        {
          kind: "json",
          value: { method: "thread/started", params: { thread: validThread(cwd, threadId) } },
        },
      ],
    };
    const turnExchange: FakeCodexExchange = {
      expectMethod: "turn/start",
      result: { turn: validTurn() },
      afterResponse: [
        {
          kind: "json",
          value: { method: "turn/started", params: { threadId, turn: validTurn() } },
        },
        {
          kind: "json",
          value: {
            method: "turn/completed",
            params: {
              threadId,
              turn: validTurn(CX02_TURN_ID, "completed", [
                { id: "i", type: "agentMessage", phase: "final_answer", text: "reply" },
              ]),
            },
          },
        },
      ],
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: {
        ...plan,
        exchanges: [...handshakeExchanges(), threadExchange, turnExchange],
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    if (bytes === 1_024) assert.equal(eventName(events.at(-1)), "reply");
    else {
      assert.deepEqual(events.at(-1), {
        event: "failed",
        execution_id: CX02_EXECUTION_ID,
        reason_code: "provider_start_failed",
      });
    }
  }

  for (const bytes of [1_024, 1_025]) {
    const approvalRequestId = `approval/${"a".repeat(bytes - 11)}`;
    assert.equal(Buffer.byteLength(`s:${approvalRequestId}`), bytes);
    const plan = activePlan(cwd, [
      {
        kind: "json",
        value: {
          id: approvalRequestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: CX02_THREAD_ID,
            turnId: CX02_TURN_ID,
            itemId: "approval_item",
            reason: "content must not cross the provider port",
          },
        },
      },
    ]);
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", { appPlan: plan });
    const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
    assert.equal(eventName((await iterator.next()).value), "session_bound");
    assert.equal(eventName((await iterator.next()).value), "turn_bound");
    const next = await iterator.next();
    if (bytes === 1_024) {
      assert.equal(eventName(next.value), "approval_required");
      assert.equal(
        (next.value as { approval_request_id?: unknown }).approval_request_id,
        `s:${approvalRequestId}`,
      );
    } else {
      assert.equal(eventName(next.value), "uncertain");
    }
    await iterator.return?.();
  }

  for (const bytes of [8_388_608, 8_388_609]) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: stdoutBoundaryPlan(cwd, bytes),
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), bytes === 8_388_608 ? "reply" : "uncertain");
  }
});

test("CX02-X22 never replaces a missing mutated or unavailable stored thread", async (t) => {
  const cwd = process.cwd();
  const responses: readonly {
    name: string;
    result?: unknown;
    error?: unknown;
  }[] = [
    { name: "missing", error: { code: -32_000, message: "stored thread missing" } },
    { name: "missing response fields", result: {} },
    { name: "different stored thread", result: { thread: validThread(cwd, "different_thread") } },
    {
      name: "mutated working directory",
      result: { ...threadSettingsResponse(cwd), cwd: `${cwd}/moved` },
    },
  ];
  for (const vector of responses) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/resume",
          ...(vector.error === undefined ? { result: vector.result } : { error: vector.error }),
        },
      ],
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X22", { appPlan: plan });
    const events = await collectEvents(adapter.resume(resumeRequest()));
    assert.ok(["failed", "uncertain"].includes(String(eventName(events.at(-1)))), vector.name);
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "thread/start"),
      false,
    );
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "turn/start"),
      false,
    );
  }
});

test("CX02-X23 excludes content auth schemas and test controls from state and staged packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx02-leakage-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const stateDirectory = join(root, "state");
  const runtimeHome = join(root, "home-runtime");
  const approvalHome = join(root, "home-approval");
  const diagnosticHome = join(root, "home-diagnostic");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(runtimeHome, { mode: 0o700 });
  await mkdir(approvalHome, { mode: 0o700 });
  await mkdir(diagnosticHome, { mode: 0o700 });
  const markers = [
    "CX02_A2A_TEXT_SECRET",
    "CX02_REPLY_SECRET",
    "CX02_TOOL_DETAIL_SECRET",
    "CX02_APPROVAL_SECRET",
    "CX02_CODEX_AUTH_SECRET",
    "CX02_POST_INPUT_CRASH_SECRET",
    "CX02_DIAGNOSTIC_SECRET",
  ] as const;
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X23", {
    workingDirectory: cwd,
    inheritedEnvironment: {
      ...syntheticCx02Environment(runtimeHome),
      OPENAI_API_KEY: markers[4],
      CX02_WEBHOOK_TOKEN: "a".repeat(48),
    },
    appPlan: activePlan(cwd, [
      {
        kind: "json",
        value: {
          method: "item/completed",
          params: {
            threadId: CX02_THREAD_ID,
            turnId: CX02_TURN_ID,
            completedAtMs: 1_788_000_001_000,
            item: {
              id: "private_tool_item",
              type: "mcpToolCall",
              server: "fixture",
              tool: "fixture_tool",
              arguments: { detail: markers[2] },
              status: "completed",
            },
          },
        },
      },
      { kind: "json", value: completed(markers[1]) },
    ]),
  });
  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
  const connector = await startConnectorRuntime({
    providerKind: "codex",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory: cwd,
    policy: "read-only",
    gatewayEndpoint: gateway.endpoint,
    stateDirectory,
    provider: adapter as unknown as ProviderPort,
  });
  t.after(async () => await connector.close());
  const message = k02Message("cx02_x23_message", "cx02_x23_conversation", markers[0]);
  gateway.enqueueMessage(message);
  assert.equal((await gateway.sendWake(connector.webhookUrl, message.id)).status, 202);
  await connector.waitForIdle();
  assert.equal(gateway.tombstone(message.id)?.outcome, "replied");
  assert.deepEqual(
    gateway.calls
      .filter((call) => call.name === "reply_message")
      .map((call) => call.arguments.payload_text_bytes),
    [17],
  );
  const launch = fake.launches.at(-1);
  assert.ok(launch !== undefined);
  const executionSurface = JSON.stringify({
    arguments: launch.arguments,
    environment: launch.environment,
  });
  for (const marker of markers) assert.ok(!executionSurface.includes(marker));
  const approval = await createCx02Adapter(t, "CX02-CX03:X23", {
    workingDirectory: cwd,
    inheritedEnvironment: {
      ...syntheticCx02Environment(approvalHome),
      OPENAI_API_KEY: markers[4],
      CX02_WEBHOOK_TOKEN: "a".repeat(48),
    },
    appPlan: activePlan(cwd, [
      {
        kind: "json",
        value: {
          id: "private_approval",
          method: "item/permissions/requestApproval",
          params: {
            threadId: CX02_THREAD_ID,
            turnId: CX02_TURN_ID,
            itemId: "private_approval_item",
            reason: markers[3],
          },
        },
      },
    ]),
  });
  const approvalIterator = approval.adapter
    .start(startRequest("approval input"))
    [Symbol.asyncIterator]();
  await approvalIterator.next();
  await approvalIterator.next();
  const approvalEvent = (await approvalIterator.next()).value;
  assert.equal(eventName(approvalEvent), "approval_required");
  assert.ok(!JSON.stringify(approvalEvent).includes(markers[3]));
  await approvalIterator.return?.();

  const crashFake = await startFakeCodexAppServer(t, [
    { kind: "version", stdout: "codex-cli 0.149.0\n" },
    {
      kind: "app-server",
      exchanges: [
        ...started(cwd),
        {
          expectMethod: "turn/start",
          result: { turn: validTurn() },
          afterResponse: [
            {
              kind: "json",
              value: {
                method: "turn/started",
                params: { threadId: CX02_THREAD_ID, turn: validTurn() },
              },
            },
            { kind: "stderr_utf8", value: `${markers[6]}\n` },
            {
              kind: "utf8",
              value: `{"method":"turn/completed","diagnostic":"${markers[5]}"\n`,
            },
          ],
          exitCodeAfter: 87,
        },
      ],
    },
  ]);
  const diagnosticCapture = await runDiagnosticWorker({
    executablePath: crashFake.executablePath,
    workingDirectory: cwd,
    homeDirectory: diagnosticHome,
    input: markers[5],
  });
  assert.deepEqual(diagnosticCapture.stdout, Buffer.from('{"done":true}\n'));
  assert.deepEqual(diagnosticCapture.stderr, Buffer.alloc(0));
  for (const marker of markers) {
    assert.ok(!diagnosticCapture.stdout.includes(Buffer.from(marker)));
    assert.ok(!diagnosticCapture.stderr.includes(Buffer.from(marker)));
  }

  const ownedRoots = [
    root,
    dirname(fake.executablePath),
    dirname(approval.fake.executablePath),
    dirname(crashFake.executablePath),
  ];
  for (const ownedRoot of ownedRoots) {
    const runtimeEntries = await readdir(ownedRoot, { recursive: true });
    for (const entry of runtimeEntries) {
      const path = join(ownedRoot, String(entry));
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch {
        continue;
      }
      for (const marker of markers) assert.ok(!body.includes(Buffer.from(marker)));
    }
  }
  const captures = JSON.stringify([
    { arguments: launch.arguments, environment: launch.environment },
    ...approval.fake.launches.map((entry) => ({
      arguments: entry.arguments,
      environment: entry.environment,
    })),
    ...crashFake.launches.map((entry) => ({
      arguments: entry.arguments,
      environment: entry.environment,
    })),
  ]);
  for (const marker of markers) assert.ok(!captures.includes(marker));

  const canonicalCwd = await realpath(cwd);
  const occupiedListener = createServer();
  await new Promise<void>((resolve, reject) => {
    occupiedListener.once("error", reject);
    occupiedListener.listen(0, "127.0.0.1", () => resolve());
  });
  const occupiedAddress = occupiedListener.address();
  assert.ok(occupiedAddress !== null && typeof occupiedAddress === "object");
  const listenerHome = join(root, "listener-home");
  await mkdir(listenerHome, { mode: 0o700 });
  const listenerState = accountStateDirectory(await realpath(listenerHome), "codex");
  const listenerReservation = reserveConnectorState(listenerState, false);
  const listenerCloseDeadlines: number[] = [];
  const listenerFailureStartedAt = Date.now();
  try {
    await assert.rejects(
      startConnectorWithProviderFactory({
        providerKind: "codex",
        webhookPort: occupiedAddress.port,
        webhookToken: K02_TOKEN,
        workingDirectory: canonicalCwd,
        policy: "read-only",
        stateReservation: listenerReservation,
        async providerFactory(options) {
          assert.deepEqual(options, { workingDirectory: canonicalCwd, policy: "read-only" });
          return managedProviderForTest(async (deadlineUnixMs) => {
            listenerCloseDeadlines.push(deadlineUnixMs);
          });
        },
      }),
      /connector_listener_unavailable/u,
    );
  } finally {
    listenerReservation.close();
    await new Promise<void>((resolve) => occupiedListener.close(() => resolve()));
  }
  assert.equal(listenerCloseDeadlines.length, 1);
  assert.ok((listenerCloseDeadlines[0] ?? 0) >= listenerFailureStartedAt);
  assert.ok((listenerCloseDeadlines[0] ?? Number.POSITIVE_INFINITY) <= Date.now() + 3_000);

  const shutdownHome = join(root, "shutdown-home");
  await mkdir(shutdownHome, { mode: 0o700 });
  const shutdownState = accountStateDirectory(await realpath(shutdownHome), "codex");
  const shutdownReservation = reserveConnectorState(shutdownState, false);
  const shutdownCloseDeadlines: number[] = [];
  const shutdownConnector = await startConnectorWithProviderFactory({
    providerKind: "codex",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory: canonicalCwd,
    policy: "read-only",
    stateReservation: shutdownReservation,
    async providerFactory() {
      return managedProviderForTest(async (deadlineUnixMs) => {
        shutdownCloseDeadlines.push(deadlineUnixMs);
        throw new Error("private managed-provider close detail");
      });
    },
  });
  const shutdownStartedAt = Date.now();
  try {
    await assert.rejects(
      shutdownConnector.shutdown("SIGTERM"),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "connector_shutdown_incomplete" &&
        !error.message.includes("managed-provider"),
    );
  } finally {
    shutdownReservation.close();
  }
  assert.equal(shutdownCloseDeadlines.length, 1);
  assert.ok((shutdownCloseDeadlines[0] ?? 0) >= shutdownStartedAt + 14_900);
  assert.ok((shutdownCloseDeadlines[0] ?? Number.POSITIVE_INFINITY) <= shutdownStartedAt + 15_100);

  for (const provider of ["codex"] as const) {
    const commandEnvironment = syntheticCx02Environment("artifact-check");
    const pnpmStore = await discoverPopulatedPnpmStore();
    await runCommand(
      process.execPath,
      [join("scripts", "build-connector.mjs"), provider],
      commandEnvironment,
    );
    await runCommand(
      process.execPath,
      [join("scripts", "stage-connector.mjs"), provider],
      commandEnvironment,
    );
    const stagedCli = join(
      ".stage",
      "connectors",
      provider,
      "package",
      "dist",
      `${provider}-connector`,
      "src",
      "cli.js",
    );
    const stagedCliSource = await readFile(stagedCli, "utf8");
    assert.equal(
      stagedCliSource.match(/createCodexAppServerAdapter/gu)?.length,
      2,
      "the staged Codex CLI does not have one fixed adapter factory",
    );
    assert.match(stagedCliSource, /await runConnectorCli\(\s*"codex",\s*async \(options\) =>/u);
    assert.ok(stagedCliSource.includes('connectorPackageVersion: "0.0.0-private"'));

    const retirementHome = join(root, "home-retirement");
    const providerAttempt = join(root, "retirement-provider-attempted");
    const retirementPreload = join(root, "retirement-provider-guard.mjs");
    await mkdir(retirementHome, { mode: 0o700 });
    await writeFile(
      retirementPreload,
      [
        'import childProcess from "node:child_process";',
        'import fs from "node:fs";',
        'import os from "node:os";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const providerAttempt = ${JSON.stringify(providerAttempt)};`,
        `const retirementHome = ${JSON.stringify(retirementHome)};`,
        "const rejectProviderProcess = () => {",
        '  fs.writeFileSync(providerAttempt, "attempted\\n", { mode: 0o600 });',
        '  throw new Error("provider process attempted during retirement");',
        "};",
        'for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {',
        "  childProcess[name] = rejectProviderProcess;",
        "}",
        "const realUserInfo = os.userInfo;",
        "os.userInfo = () => ({ ...realUserInfo(), homedir: retirementHome });",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const guardedStartPort = await unusedLoopbackPort();
    const guardedStartArguments = [
      "start",
      `--webhook-port=${guardedStartPort}`,
      "--webhook-token-env=CX02_WEBHOOK_TOKEN",
      `--working-directory=${await realpath(cwd)}`,
      "--policy=read-only",
    ];
    assert.deepEqual(
      await runCapturedCommand(
        process.execPath,
        [`--import=${retirementPreload}`, stagedCli, ...guardedStartArguments],
        commandEnvironment,
      ),
      {
        code: 4,
        signal: null,
        stdout: "",
        stderr: "a2a connector: webhook_token_unavailable\n",
      },
    );
    await assert.rejects(readFile(providerAttempt), /ENOENT/u);
    await runCommand(
      process.execPath,
      [
        `--import=${retirementPreload}`,
        stagedCli,
        "retire-state",
        "--confirm=retire-all-correlation",
      ],
      commandEnvironment,
    );
    await assert.rejects(readFile(providerAttempt), /ENOENT/u);

    const preparationHome = join(root, "home-preparation");
    const preparationAttempt = join(root, "preparation-provider-attempted");
    const preparationPreload = join(root, "preparation-provider-guard.mjs");
    await mkdir(preparationHome, { mode: 0o700 });
    const preparationState = accountStateDirectory(await realpath(preparationHome), "codex");
    const preparationStateOptions = {
      stateDirectory: preparationState,
      webhookToken: K02_TOKEN,
      providerKind: "codex" as const,
      workingDirectory: canonicalCwd,
    };
    await initializeConnectorStateForTest(preparationStateOptions);
    await seedConnectorConversationsForTest({
      ...preparationStateOptions,
      count: 1,
      activeConversationId: "cx02_preparation_conversation",
      activeProviderSessionId: "cx02_preparation_session",
      openMessageCount: 1,
    });
    const preparationDatabase = new Database(join(preparationState, "correlation.sqlite3"));
    try {
      assert.equal(
        preparationDatabase.prepare("UPDATE messages SET lifecycle='blocked'").run().changes,
        1,
      );
    } finally {
      preparationDatabase.close();
    }
    await writeFile(
      preparationPreload,
      [
        'import childProcess from "node:child_process";',
        'import fs from "node:fs";',
        'import os from "node:os";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const preparationAttempt = ${JSON.stringify(preparationAttempt)};`,
        `const preparationHome = ${JSON.stringify(preparationHome)};`,
        "const rejectProviderProcess = () => {",
        '  fs.writeFileSync(preparationAttempt, "attempted\\n", { mode: 0o600 });',
        '  throw new Error("provider process attempted before startup recovery validation");',
        "};",
        'for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {',
        "  childProcess[name] = rejectProviderProcess;",
        "}",
        "const realUserInfo = os.userInfo;",
        "os.userInfo = () => ({ ...realUserInfo(), homedir: preparationHome });",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.deepEqual(
      await runCapturedCommand(
        process.execPath,
        [`--import=${preparationPreload}`, stagedCli, ...guardedStartArguments],
        {
          ...commandEnvironment,
          PATH: dirname(fake.executablePath),
          CX02_WEBHOOK_TOKEN: K02_TOKEN,
        },
      ),
      {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "a2a connector: connector_message_blocked\n",
      },
    );
    await assert.rejects(readFile(preparationAttempt), /ENOENT/u);
    assert.deepEqual(
      await retireConnectorStateForTest({
        stateDirectory: preparationState,
        providerKind: "codex",
        arguments: ["retire-state", "--confirm=retire-all-correlation"],
      }),
      { exitCode: 0, stdout: "Connector correlation state retired.\n", stderr: "" },
    );

    const containmentHome = join(root, "home-containment");
    const containmentAttempt = join(root, "containment-attempted");
    const containmentPreload = join(root, "containment-guard.mjs");
    await mkdir(containmentHome, { mode: 0o700 });
    await writeFile(
      containmentPreload,
      [
        'import fs from "node:fs";',
        'import os from "node:os";',
        `const containmentAttempt = ${JSON.stringify(containmentAttempt)};`,
        `const containmentHome = ${JSON.stringify(containmentHome)};`,
        "const realKill = process.kill.bind(process);",
        "process.kill = (pid, signal) => {",
        "  if (pid < 0) {",
        '    fs.writeFileSync(containmentAttempt, "attempted\\n", { mode: 0o600 });',
        '    const error = new Error("owned process group signal failed");',
        '    error.code = "EPERM";',
        "    throw error;",
        "  }",
        "  return realKill(pid, signal);",
        "};",
        "const realUserInfo = os.userInfo;",
        "os.userInfo = () => ({ ...realUserInfo(), homedir: containmentHome });",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const containmentFake = await startFakeCodexAppServer(t, [{ kind: "version", hold: true }]);
    const containmentEnvironment = {
      ...commandEnvironment,
      PATH: `${dirname(containmentFake.executablePath)}:${commandEnvironment.PATH}`,
      CX02_WEBHOOK_TOKEN: "a".repeat(48),
    };
    assert.deepEqual(
      await runCapturedCommand(
        process.execPath,
        [`--import=${containmentPreload}`, stagedCli, ...guardedStartArguments],
        containmentEnvironment,
      ),
      {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "a2a connector: connector_shutdown_incomplete\n",
      },
    );
    assert.deepEqual(await readFile(containmentAttempt, "utf8"), "attempted\n");
    await assertLoopbackPortReusable(guardedStartPort);
    await runCommand(
      process.execPath,
      [join("scripts", "check-packed-connector.mjs"), provider, `--store-dir=${pnpmStore}`],
      commandEnvironment,
    );
  }
  const stagedRoot = ".stage/connectors/codex/package";
  const entries = await readdir(stagedRoot, { recursive: true });
  assert.ok(entries.every((entry) => !String(entry).includes("schemas.json")));
  assert.ok(entries.every((entry) => !String(entry).includes("fixture")));
  for (const entry of entries) {
    const path = join(stagedRoot, String(entry));
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      continue;
    }
    const serialized = body.toString("utf8");
    for (const marker of markers) assert.ok(!serialized.includes(marker));
    for (const control of [
      "ForTest",
      "fixtureExecutablePath",
      "afterVersionProbeForTest",
      "codex-app-server/0.149.0",
    ]) {
      assert.ok(!serialized.includes(control));
    }
  }
  const schema = await readFile(
    "test/fixtures/codex-app-server/0.149.0/codex_app_server_protocol.v2.schemas.json",
  );
  assert.equal(
    createHash("sha256").update(schema).digest("hex"),
    "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9",
  );
});
