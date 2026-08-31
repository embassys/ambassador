import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { CONNECTOR_LIMITS, connectorError } from "../../connector-core/src/constants.js";
import { buildProviderChildEnvironment } from "../../connector-core/src/provider-boundary.js";
import {
  type ConnectorClock,
  type ProviderPort,
  SYSTEM_CLOCK,
} from "../../connector-core/src/runtime-types.js";

export const CLAUDE_CODE_VERSION = "2.1.251";

const VERSION_STDOUT = `${CLAUDE_CODE_VERSION} (Claude Code)\n`;
const VERSION_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 5_000;
const VERSION_STDOUT_BYTES = 64;
const VERSION_STDERR_BYTES = 1_024;
const PROVIDER_RECORD_BYTES = 1_048_576;
const PROVIDER_RECORD_DEPTH = 100;
const MONITOR_RECORD_BYTES = 16_384;
const MONITOR_RECORD_DEPTH = 16;
const MONITOR_RECORD_COUNT = 32;
const MONITOR_TOTAL_BYTES = 65_536;
const CLEANUP_TIMEOUT_MS = 3_000;
const LATE_EVENT_GRACE_MS = 1_000;
const TERMINAL_MEMORY = 100;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Policy = "read-only" | "workspace-write";
type Scope = "version" | "turn";
type ProcessBarrier =
  | "before_monitor_ready"
  | "before_start_write"
  | "during_start_record"
  | "before_claude_spawn"
  | "after_claude_spawn"
  | "before_child_started"
  | "after_child_started"
  | "before_init"
  | "after_session_bound"
  | "during_stdin_write"
  | "after_replay"
  | "during_tools"
  | "after_terminal_candidate"
  | "after_child_exited";
type ProcessObservation =
  | "monitor_pid_recorded"
  | "ready"
  | "start_written"
  | "child_started"
  | "child_exited"
  | "contain_written"
  | "sigterm_sent"
  | "sigkill_sent"
  | "monitor_reaped"
  | "group_empty_proved";

interface MonitorSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"];
}

type SpawnMonitor = (
  executable: string,
  arguments_: readonly string[],
  options: MonitorSpawnOptions,
) => ChildProcess;

interface AdapterOptions {
  readonly workingDirectory: string;
  readonly policy: Policy;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
  readonly connectorPackageVersion: string;
  readonly clock?: ConnectorClock;
  readonly fixtureExecutablePath?: string | null;
  readonly afterVersionProbeForTest?: () => void | Promise<void>;
  readonly uuidForTest?: (kind: "session" | "input") => string;
  readonly spawnMonitorForTest?: SpawnMonitor;
  readonly processBarrierForTest?: (event: {
    readonly scope: Scope;
    readonly barrier: ProcessBarrier;
  }) => Promise<void>;
  readonly processObserverForTest?: (event: {
    readonly scope: Scope;
    readonly observation: ProcessObservation;
  }) => void;
  readonly processGroupProbeForTest?: (pgid: number) => "empty" | "accessible" | "denied";
}

interface ExecutableIdentity {
  readonly path: string;
  readonly launchPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mode: number;
}

interface InvocationRequest {
  readonly kind: string;
  readonly execution_id: string;
  readonly deadline_unix_ms: number;
  readonly provider_session_id?: string | null;
  readonly input_text?: string;
}

interface CancelRequest {
  readonly execution_id: string;
  readonly provider_session_id: string | null;
}

interface CancelResult {
  readonly status: "cancel_requested" | "already_terminal" | "not_found";
}

type TerminalEvent =
  | { readonly event: "reply"; readonly execution_id: string; readonly text: string }
  | {
      readonly event: "failed" | "uncertain";
      readonly execution_id: string;
      readonly reason_code:
        | "provider_start_failed"
        | "provider_execution_failed"
        | "provider_result_invalid"
        | "provider_outcome_unknown";
    };

type WireEvent =
  | {
      readonly source: "provider";
      readonly record: Record<string, unknown>;
      readonly raw: Buffer;
    }
  | {
      readonly source: "lifecycle";
      readonly record: Record<string, unknown>;
      readonly raw: Buffer;
    }
  | { readonly source: "provider_end" | "lifecycle_end" | "monitor_close" };

interface QueueWaiter {
  resolve(value: WireEvent): void;
  reject(error: Error): void;
}

interface Invocation {
  readonly scope: Scope;
  readonly executionId: string;
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly pgid: number;
  readonly providerInput: Writable;
  readonly control: Writable;
  readonly owner: Writable;
  readonly queue: AsyncEventQueue;
  lifecycleState: "launched" | "ready" | "started" | "exited";
  childExit: { readonly code: number | null; readonly signal: number | null } | undefined;
  providerEnded: boolean;
  startWritten: boolean;
  dispatchMayHaveReachedProvider: boolean;
  interruptSent: boolean;
  terminalKnown: boolean;
  monitorClosed: boolean;
  cleanupConflict: boolean;
  cleanupPromise: Promise<boolean> | undefined;
}

class ProtocolFailure extends Error {}
class OutputFailure extends Error {}
class ProcessEnded extends Error {}
class DeadlineFailure extends Error {}
class ContainmentFailure extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUnicodeScalarString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return (
    isUnicodeScalarString(value) &&
    (allowEmpty || Buffer.byteLength(value, "utf8") > 0) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

class StrictJsonScanner {
  #index = 0;

  constructor(
    private readonly source: string,
    private readonly maximumDepth: number,
  ) {}

  parse(): unknown {
    this.#space();
    const value = this.#value(0);
    this.#space();
    if (this.#index !== this.source.length) throw new ProtocolFailure();
    return value;
  }

  #space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #value(depth: number): unknown {
    this.#space();
    const character = this.source[this.#index];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    if (this.source.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #container(depth: number): void {
    if (depth > this.maximumDepth) throw new ProtocolFailure();
  }

  #object(depth: number): Record<string, unknown> {
    this.#container(depth);
    this.#index += 1;
    this.#space();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.#index] !== '"') throw new ProtocolFailure();
      const key = this.#string();
      if (keys.has(key)) throw new ProtocolFailure();
      keys.add(key);
      this.#space();
      if (this.source[this.#index] !== ":") throw new ProtocolFailure();
      this.#index += 1;
      result[key] = this.#value(depth);
      this.#space();
      const delimiter = this.source[this.#index];
      this.#index += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") throw new ProtocolFailure();
      this.#space();
    }
  }

  #array(depth: number): unknown[] {
    this.#container(depth);
    this.#index += 1;
    this.#space();
    const result: unknown[] = [];
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.#value(depth));
      this.#space();
      const delimiter = this.source[this.#index];
      this.#index += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") throw new ProtocolFailure();
      this.#space();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    for (;;) {
      const character = this.source[this.#index];
      if (character === undefined) throw new ProtocolFailure();
      if (character === '"') {
        this.#index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.#index));
        } catch {
          throw new ProtocolFailure();
        }
        if (typeof value !== "string") throw new ProtocolFailure();
        return value;
      }
      if (character === "\\") {
        this.#index += 1;
        const escaped = this.source[this.#index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.#index + 1, this.#index + 5))) {
            throw new ProtocolFailure();
          }
          this.#index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escaped ?? "")) {
          throw new ProtocolFailure();
        }
        this.#index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new ProtocolFailure();
      this.#index += 1;
    }
  }

  #number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.#index),
    );
    if (match === null) throw new ProtocolFailure();
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ProtocolFailure();
    return value;
  }
}

function parseStrictRecord(bytes: Buffer, maximumDepth: number): Record<string, unknown> {
  if (bytes.byteLength === 0) throw new ProtocolFailure();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolFailure();
  }
  const value = new StrictJsonScanner(source, maximumDepth).parse();
  if (!isRecord(value)) throw new ProtocolFailure();
  return value;
}

class AsyncEventQueue {
  readonly #values: WireEvent[] = [];
  readonly #waiters: QueueWaiter[] = [];
  #failure: Error | undefined;

  push(value: WireEvent): void {
    if (this.#failure !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve(value);
  }

  fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<WireEvent> {
    return this.wait().promise;
  }

  wait(): { readonly promise: Promise<WireEvent>; cancel(): void } {
    if (this.#failure !== undefined) {
      return { promise: Promise.reject(this.#failure), cancel() {} };
    }
    const value = this.#values.shift();
    if (value !== undefined) return { promise: Promise.resolve(value), cancel() {} };
    let waiter: QueueWaiter | undefined;
    const promise = new Promise<WireEvent>((resolve, reject) => {
      waiter = { resolve, reject };
      this.#waiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (waiter === undefined) return;
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter = undefined;
      },
    };
  }

  tryNext(): WireEvent | undefined {
    if (this.#failure !== undefined) throw this.#failure;
    return this.#values.shift();
  }
}

function attachJsonl(
  stream: Readable,
  source: "provider" | "lifecycle",
  queue: AsyncEventQueue,
  options: {
    readonly recordBytes: number;
    readonly depth: number;
    readonly totalBytes: number;
    readonly recordCount?: number;
  },
): void {
  let line = Buffer.alloc(0);
  let total = 0;
  let count = 0;
  stream.on("data", (raw: string | Buffer) => {
    const chunk = Buffer.from(raw);
    total += chunk.byteLength;
    if (total > options.totalBytes) {
      queue.fail(new OutputFailure());
      return;
    }
    line = Buffer.concat([line, chunk]);
    for (;;) {
      const newline = line.indexOf(0x0a);
      if (newline < 0) {
        if (line.byteLength > options.recordBytes) queue.fail(new ProtocolFailure());
        return;
      }
      const bytes = Buffer.from(line.subarray(0, newline));
      line = line.subarray(newline + 1);
      count += 1;
      if (options.recordCount !== undefined && count > options.recordCount) {
        queue.fail(new ProtocolFailure());
        return;
      }
      if (bytes.byteLength > options.recordBytes) {
        queue.fail(new ProtocolFailure());
        return;
      }
      try {
        queue.push({ source, record: parseStrictRecord(bytes, options.depth), raw: bytes });
      } catch (error) {
        queue.fail(error instanceof Error ? error : new ProtocolFailure());
        return;
      }
    }
  });
  stream.once("error", () => queue.fail(new OutputFailure()));
  stream.once("end", () => {
    if (line.byteLength > 0) queue.fail(new ProtocolFailure());
    else queue.push({ source: source === "provider" ? "provider_end" : "lifecycle_end" });
  });
}

function timerPromise(
  clock: ConnectorClock,
  delayMs: number,
): { promise: Promise<void>; cancel(): void } {
  let timer: unknown;
  const promise = new Promise<void>((resolve) => {
    timer = clock.setTimer(resolve, Math.max(0, delayMs));
  });
  return { promise, cancel: () => clock.clearTimer(timer) };
}

async function resolveExecutable(
  requested: string | null | undefined,
  environment: Readonly<Record<string, string>>,
): Promise<string | null> {
  if (requested === null) return null;
  if (requested !== undefined) {
    try {
      await access(requested, fsConstants.X_OK);
      return requested;
    } catch {
      return null;
    }
  }
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, "claude");
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue the one fixed PATH lookup.
    }
  }
  return null;
}

async function executableIdentity(
  path: string,
  launchPath = path,
): Promise<ExecutableIdentity | null> {
  try {
    const value = await stat(path);
    if (!value.isFile() || (value.mode & 0o111) === 0) return null;
    return {
      path,
      launchPath,
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
      mode: value.mode,
    };
  } catch {
    return null;
  }
}

function sameIdentity(left: ExecutableIdentity, right: ExecutableIdentity | null): boolean {
  return (
    right !== null &&
    left.path === right.path &&
    left.launchPath === right.launchPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

function streamAt(child: ChildProcess, index: number): Readable | Writable {
  const stream = child.stdio[index];
  if (stream === null || stream === undefined) throw new ContainmentFailure();
  return stream as Readable | Writable;
}

function processGroupProbe(pgid: number): "empty" | "accessible" | "denied" {
  try {
    process.kill(-pgid, 0);
    return "accessible";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "empty";
    if ((error as NodeJS.ErrnoException).code === "EPERM") return "denied";
    return "accessible";
  }
}

async function waitReal(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function exactArguments(
  kind: "start" | "resume",
  policy: Policy,
  sessionId: string,
): readonly string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--safe-mode",
    "--restricted",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools",
    policy === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
    "--disallowedTools",
    "mcp__*",
    kind === "start" ? "--session-id" : "--resume",
    sessionId,
  ];
}

function providerInput(text: string, sessionId: string, uuid: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

function validInit(
  record: Record<string, unknown>,
  cwd: string,
  policy: Policy,
  sessionId: string,
): boolean {
  const tools =
    policy === "read-only" ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Edit", "Write"];
  return (
    hasExactKeys(record, [
      "type",
      "subtype",
      "session_id",
      "cwd",
      "tools",
      "mcp_servers",
      "plugins",
      "permissionMode",
      "claude_code_version",
    ]) &&
    record.type === "system" &&
    record.subtype === "init" &&
    record.session_id === sessionId &&
    record.cwd === cwd &&
    Array.isArray(record.tools) &&
    record.tools.length === tools.length &&
    record.tools.every((value, index) => value === tools[index]) &&
    Array.isArray(record.mcp_servers) &&
    record.mcp_servers.length === 0 &&
    Array.isArray(record.plugins) &&
    record.plugins.length === 0 &&
    record.permissionMode === "dontAsk" &&
    record.claude_code_version === CLAUDE_CODE_VERSION
  );
}

function validProviderId(value: unknown): value is string {
  return boundedString(value, CONNECTOR_LIMITS.providerIdBytes);
}

function validateActivity(record: Record<string, unknown>, sessionId: string): { tool: boolean } {
  if (record.type === "assistant") {
    if (
      !hasExactKeys(record, ["type", "uuid", "session_id", "message", "parent_tool_use_id"]) ||
      !validProviderId(record.uuid) ||
      record.session_id !== sessionId ||
      record.parent_tool_use_id !== null ||
      !isRecord(record.message) ||
      !hasExactKeys(record.message, ["role", "content"]) ||
      record.message.role !== "assistant" ||
      !Array.isArray(record.message.content) ||
      record.message.content.length === 0
    ) {
      throw new ProtocolFailure();
    }
    let tool = false;
    for (const content of record.message.content) {
      if (!isRecord(content)) throw new ProtocolFailure();
      if (content.type === "text") {
        if (!hasExactKeys(content, ["type", "text"]) || !isUnicodeScalarString(content.text)) {
          throw new ProtocolFailure();
        }
      } else if (content.type === "tool_use") {
        if (
          !hasExactKeys(content, ["type", "id", "name", "input"]) ||
          !validProviderId(content.id) ||
          !validProviderId(content.name)
        ) {
          throw new ProtocolFailure();
        }
        tool = true;
      } else throw new ProtocolFailure();
    }
    return { tool };
  }
  if (record.type === "user") {
    if (
      !hasExactKeys(record, ["type", "uuid", "session_id", "message", "parent_tool_use_id"]) ||
      !validProviderId(record.uuid) ||
      record.session_id !== sessionId ||
      !validProviderId(record.parent_tool_use_id) ||
      !isRecord(record.message) ||
      !hasExactKeys(record.message, ["role", "content"]) ||
      record.message.role !== "user" ||
      !Array.isArray(record.message.content) ||
      record.message.content.length === 0
    ) {
      throw new ProtocolFailure();
    }
    for (const content of record.message.content) {
      if (
        !isRecord(content) ||
        content.type !== "tool_result" ||
        !hasExactKeys(content, ["type", "tool_use_id", "content"]) ||
        !validProviderId(content.tool_use_id)
      ) {
        throw new ProtocolFailure();
      }
    }
    return { tool: true };
  }
  const simple: Readonly<Record<string, readonly string[]>> = {
    api_retry: ["type", "session_id", "attempt"],
    rate_limit_event: ["type", "session_id", "status"],
    status: ["type", "session_id", "status"],
    compact_boundary: ["type", "session_id"],
    tool_progress: ["type", "session_id", "tool_use_id"],
    tool_summary: ["type", "session_id", "tool_use_id"],
  };
  const keys = simple[String(record.type)];
  if (keys === undefined || !hasExactKeys(record, keys) || record.session_id !== sessionId) {
    throw new ProtocolFailure();
  }
  if (record.type === "api_retry" && !Number.isSafeInteger(record.attempt)) {
    throw new ProtocolFailure();
  }
  if (
    ["rate_limit_event", "status"].includes(String(record.type)) &&
    !isUnicodeScalarString(record.status)
  ) {
    throw new ProtocolFailure();
  }
  if (
    ["tool_progress", "tool_summary"].includes(String(record.type)) &&
    !validProviderId(record.tool_use_id)
  ) {
    throw new ProtocolFailure();
  }
  return { tool: ["tool_progress", "tool_summary"].includes(String(record.type)) };
}

function terminalFromResult(
  record: Record<string, unknown>,
  executionId: string,
  sessionId: string,
): TerminalEvent {
  if (!hasExactKeys(record, ["type", "subtype", "session_id", "is_error", "result"])) {
    return { event: "failed", execution_id: executionId, reason_code: "provider_result_invalid" };
  }
  if (record.session_id !== sessionId) {
    return {
      event: "uncertain",
      execution_id: executionId,
      reason_code: "provider_outcome_unknown",
    };
  }
  if (
    record.subtype === "error" &&
    record.is_error === true &&
    isUnicodeScalarString(record.result)
  ) {
    return {
      event: "failed",
      execution_id: executionId,
      reason_code: "provider_execution_failed",
    };
  }
  if (record.subtype !== "success" || record.is_error !== false) {
    return { event: "failed", execution_id: executionId, reason_code: "provider_result_invalid" };
  }
  if (!boundedString(record.result, CONNECTOR_LIMITS.finalReplyBytes)) {
    return { event: "failed", execution_id: executionId, reason_code: "provider_result_invalid" };
  }
  return { event: "reply", execution_id: executionId, text: record.result };
}

class ClaudeCodeAdapter implements ProviderPort {
  readonly spawnRecord: {
    executable: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
    shell: false;
  };
  containmentAttempts = 0;
  postTerminalDeliveries = 0;
  readonly #clock: ConnectorClock;
  readonly #spawnMonitor: SpawnMonitor;
  readonly #monitorPath: string;
  readonly #active = new Map<string, Invocation>();
  readonly #terminal = new Set<string>();
  readonly #terminalOrder: string[] = [];
  #available = false;
  #closed = false;

  constructor(
    private readonly options: AdapterOptions,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly identity: ExecutableIdentity | null,
  ) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#monitorPath = fileURLToPath(new URL("./claude-lifetime-monitor.js", import.meta.url));
    this.#spawnMonitor =
      options.spawnMonitorForTest ??
      ((executable, arguments_, spawnOptions) =>
        spawn(executable, [...arguments_], {
          cwd: spawnOptions.cwd,
          env: { ...spawnOptions.env },
          detached: spawnOptions.detached,
          shell: spawnOptions.shell,
          stdio: [...spawnOptions.stdio],
          windowsHide: true,
        }));
    this.spawnRecord = {
      executable: process.execPath,
      arguments: [this.#monitorPath],
      environment: { ...environment },
      shell: false,
    };
  }

  setAvailable(value: boolean): void {
    this.#available = value;
  }

  async preflight(): Promise<boolean> {
    if (this.identity === null) return false;
    let invocation: Invocation | undefined;
    let exact = false;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    try {
      invocation = this.#launch("version", "version", "00000000-0000-4000-8000-000000000000");
      const child = invocation.child;
      (child.stdout as Readable).on("data", (raw: string | Buffer) => {
        const chunk = Buffer.from(raw);
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > VERSION_STDOUT_BYTES) overflow = true;
        else stdout.push(chunk);
      });
      (child.stderr as Readable).on("data", (raw: string | Buffer) => {
        stderrBytes += Buffer.byteLength(raw);
        if (stderrBytes > VERSION_STDERR_BYTES) overflow = true;
      });
      const deadline = this.#clock.nowMs() + VERSION_TIMEOUT_MS;
      await this.#barrier("version", "before_monitor_ready");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.#expectLifecycle(invocation, "ready", deadline);
      await this.#barrier("version", "before_start_write");
      await this.#writeControl(invocation, {
        type: "start",
        executable: this.identity.launchPath,
        arguments: ["--version"],
      });
      invocation.startWritten = true;
      this.#observe("version", "start_written");
      await this.#expectLifecycle(invocation, "child_started", deadline);
      await this.#expectLifecycle(invocation, "child_exited", deadline);
      await new Promise<void>((resolve) => setImmediate(resolve));
      exact =
        !overflow &&
        invocation.childExit?.code === 0 &&
        invocation.childExit.signal === null &&
        Buffer.concat(stdout).toString("utf8") === VERSION_STDOUT;
    } catch (error) {
      if (error instanceof ContainmentFailure) throw error;
    }
    if (invocation !== undefined) {
      await this.#cleanupOrThrow(invocation);
      if (invocation.cleanupConflict) exact = false;
    }
    return exact;
  }

  start(request: Record<string, unknown>): AsyncIterable<unknown> {
    return this.#invoke(request as unknown as InvocationRequest, "start");
  }

  resume(request: Record<string, unknown>): AsyncIterable<unknown> {
    return this.#invoke(request as unknown as InvocationRequest, "resume");
  }

  async *recover(request: Record<string, unknown>): AsyncIterable<unknown> {
    const candidate = request as unknown as InvocationRequest;
    yield {
      event: "uncertain",
      execution_id: candidate.execution_id,
      reason_code: "provider_outcome_unknown",
    };
  }

  async cancel(request: Record<string, unknown>): Promise<CancelResult> {
    const candidate = request as unknown as CancelRequest;
    if (this.#terminal.has(candidate.execution_id)) return { status: "already_terminal" };
    const invocation = this.#active.get(candidate.execution_id);
    if (invocation === undefined || candidate.provider_session_id !== invocation.sessionId) {
      return { status: "not_found" };
    }
    if (invocation.terminalKnown) return { status: "already_terminal" };
    if (!invocation.interruptSent) {
      invocation.interruptSent = true;
      try {
        await this.#writeControl(invocation, { type: "interrupt" });
      } catch {
        // The invocation will classify its already uncertain process outcome.
      }
    }
    return { status: "cancel_requested" };
  }

  async contain(executionId: string): Promise<boolean> {
    const invocation = this.#active.get(executionId);
    return invocation === undefined ? true : await this.#cleanup(invocation);
  }

  async close(_deadlineUnixMs?: number): Promise<void> {
    this.#closed = true;
    const results = await Promise.all(
      [...this.#active.values()].map(async (entry) => await this.#cleanup(entry)),
    );
    if (results.some((value) => !value)) throw new ContainmentFailure();
  }

  async *#invoke(request: InvocationRequest, kind: "start" | "resume"): AsyncIterable<unknown> {
    const failed = (): TerminalEvent => ({
      event: "failed",
      execution_id: request.execution_id,
      reason_code: "provider_start_failed",
    });
    if (
      this.#closed ||
      !this.#available ||
      this.identity === null ||
      !sameIdentity(
        this.identity,
        await executableIdentity(this.identity.path, this.identity.launchPath),
      ) ||
      typeof request.execution_id !== "string" ||
      typeof request.input_text !== "string" ||
      !Number.isSafeInteger(request.deadline_unix_ms)
    ) {
      yield failed();
      return;
    }
    const sessionId =
      kind === "start" ? this.#uuid("session") : (request.provider_session_id ?? "");
    if (!SESSION_ID.test(sessionId)) {
      yield failed();
      return;
    }
    let invocation: Invocation | undefined;
    let terminal: TerminalEvent | undefined;
    let normalizedEvents = 0;
    try {
      invocation = this.#launch("turn", request.execution_id, sessionId);
      this.#active.set(request.execution_id, invocation);
      const startupDeadline = Math.min(
        request.deadline_unix_ms,
        this.#clock.nowMs() + STARTUP_TIMEOUT_MS,
      );
      await this.#barrier("turn", "before_monitor_ready");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.#expectLifecycle(invocation, "ready", startupDeadline);
      await this.#barrier("turn", "before_start_write");
      await this.#writeControl(invocation, {
        type: "start",
        executable: this.identity.launchPath,
        arguments: exactArguments(kind, this.options.policy, sessionId),
      });
      invocation.startWritten = true;
      this.#observe("turn", "start_written");
      await this.#expectLifecycle(invocation, "child_started", startupDeadline);
      await this.#barrier("turn", "after_child_started");
      await this.#barrier("turn", "before_init");
      if (invocation.interruptSent) {
        await this.#awaitInterruptedExit(invocation, startupDeadline);
      }
      const init = await this.#nextProvider(invocation, startupDeadline, STARTUP_TIMEOUT_MS);
      if (!validInit(init.record, this.options.workingDirectory, this.options.policy, sessionId)) {
        throw new ProtocolFailure();
      }
      if (kind === "start") {
        normalizedEvents += 1;
        yield {
          event: "session_bound",
          execution_id: request.execution_id,
          provider_session_id: sessionId,
        };
        await this.#barrier("turn", "after_session_bound");
        if (invocation.interruptSent) {
          await this.#awaitInterruptedExit(invocation, request.deadline_unix_ms);
        }
      }
      const inputUuid = this.#uuid("input");
      const input = providerInput(request.input_text, sessionId, inputUuid);
      const inputBytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      invocation.dispatchMayHaveReachedProvider = true;
      await this.#barrier("turn", "during_stdin_write");
      if (invocation.interruptSent) {
        await this.#awaitInterruptedExit(invocation, request.deadline_unix_ms);
      }
      await new Promise<void>((resolve, reject) => {
        invocation?.providerInput.end(inputBytes, (error?: Error | null) =>
          error === undefined || error === null ? resolve() : reject(error),
        );
      });
      const replay = await this.#nextProvider(invocation, request.deadline_unix_ms);
      if (!replay.raw.equals(inputBytes.subarray(0, inputBytes.byteLength - 1))) {
        throw new ProtocolFailure();
      }
      await this.#barrier("turn", "after_replay");

      while (terminal === undefined) {
        const event = await this.#nextUntil(
          invocation,
          request.deadline_unix_ms,
          invocation.lifecycleState === "exited" && this.options.clock !== undefined
            ? STARTUP_TIMEOUT_MS
            : undefined,
        );
        if (event.source === "provider") {
          if (event.record.type === "result") {
            terminal = terminalFromResult(event.record, request.execution_id, sessionId);
            if (
              invocation.childExit !== undefined &&
              (invocation.childExit.code !== 0 || invocation.childExit.signal !== null)
            ) {
              terminal = {
                event: "uncertain",
                execution_id: request.execution_id,
                reason_code: "provider_outcome_unknown",
              };
            }
            invocation.terminalKnown = true;
            await this.#barrier("turn", "after_terminal_candidate");
            break;
          }
          const activity = validateActivity(event.record, sessionId);
          if (activity.tool) await this.#barrier("turn", "during_tools");
          normalizedEvents += 1;
          if (normalizedEvents >= CONNECTOR_LIMITS.normalizedEvents) {
            throw new OutputFailure();
          }
          yield {
            event: "progress",
            execution_id: request.execution_id,
            text: "provider_activity",
          };
          continue;
        }
        await this.#handleLifecycle(invocation, event);
      }

      const graceDeadline = Date.now() + LATE_EVENT_GRACE_MS;
      while (Date.now() < graceDeadline) {
        let event = invocation.queue.tryNext();
        if (event === undefined) {
          const remaining = graceDeadline - Date.now();
          if (remaining <= 0) break;
          const waiting = invocation.queue.wait();
          let timer: NodeJS.Timeout | undefined;
          const observed = await Promise.race([
            waiting.promise.then((value) => ({ value })),
            new Promise<{ value?: undefined }>((resolve) => {
              timer = setTimeout(() => resolve({}), Math.min(10, remaining));
            }),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (observed.value === undefined) waiting.cancel();
          event = observed.value;
          if (event === undefined) continue;
        }
        if (event.source === "provider") {
          terminal = {
            event: "uncertain",
            execution_id: request.execution_id,
            reason_code: "provider_outcome_unknown",
          };
          continue;
        }
        if (event.source === "provider_end") {
          invocation.providerEnded = true;
          continue;
        }
        await this.#handleLifecycle(invocation, event);
        if (
          invocation.childExit !== undefined &&
          (invocation.childExit.code !== 0 || invocation.childExit.signal !== null)
        ) {
          terminal = {
            event: "uncertain",
            execution_id: request.execution_id,
            reason_code: "provider_outcome_unknown",
          };
        }
      }
      if (invocation.childExit !== undefined && !invocation.providerEnded) {
        terminal = {
          event: "uncertain",
          execution_id: request.execution_id,
          reason_code: "provider_outcome_unknown",
        };
      }
      normalizedEvents += 1;
      if (normalizedEvents > CONNECTOR_LIMITS.normalizedEvents) throw new OutputFailure();
    } catch {
      terminal = invocation?.dispatchMayHaveReachedProvider
        ? {
            event: "uncertain",
            execution_id: request.execution_id,
            reason_code: "provider_outcome_unknown",
          }
        : failed();
    } finally {
      if (invocation !== undefined) {
        await this.#cleanupOrThrow(invocation);
        if (invocation.cleanupConflict) {
          terminal = invocation.dispatchMayHaveReachedProvider
            ? {
                event: "uncertain",
                execution_id: request.execution_id,
                reason_code: "provider_outcome_unknown",
              }
            : failed();
        }
        this.#active.delete(request.execution_id);
      }
    }
    const result = terminal ?? failed();
    this.#rememberTerminal(request.execution_id);
    yield result;
  }

  #uuid(kind: "session" | "input"): string {
    const value = this.options.uuidForTest?.(kind) ?? randomUUID();
    if (!SESSION_ID.test(value)) throw new ProtocolFailure();
    return value;
  }

  #launch(scope: Scope, executionId: string, sessionId: string): Invocation {
    const child = this.#spawnMonitor(process.execPath, [this.#monitorPath], {
      cwd: this.options.workingDirectory,
      env: this.environment,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    if (child.pid === undefined || child.pid <= 0 || process.platform === "win32") {
      throw new ContainmentFailure();
    }
    const queue = new AsyncEventQueue();
    const invocation: Invocation = {
      scope,
      executionId,
      sessionId,
      child,
      pgid: child.pid,
      providerInput: child.stdin as Writable,
      control: streamAt(child, 4) as Writable,
      owner: streamAt(child, 3) as Writable,
      queue,
      lifecycleState: "launched",
      childExit: undefined,
      providerEnded: false,
      startWritten: false,
      dispatchMayHaveReachedProvider: false,
      interruptSent: false,
      terminalKnown: false,
      monitorClosed: false,
      cleanupConflict: false,
      cleanupPromise: undefined,
    };
    this.#observe(scope, "monitor_pid_recorded");
    if (scope === "turn") {
      attachJsonl(child.stdout as Readable, "provider", queue, {
        recordBytes: PROVIDER_RECORD_BYTES,
        depth: PROVIDER_RECORD_DEPTH,
        totalBytes: CONNECTOR_LIMITS.providerOutputBytes,
      });
    }
    attachJsonl(streamAt(child, 5) as Readable, "lifecycle", queue, {
      recordBytes: MONITOR_RECORD_BYTES,
      depth: MONITOR_RECORD_DEPTH,
      totalBytes: MONITOR_TOTAL_BYTES,
      recordCount: MONITOR_RECORD_COUNT,
    });
    let stderrBytes = 0;
    (child.stderr as Readable).on("data", (raw: string | Buffer) => {
      stderrBytes += Buffer.byteLength(raw);
      const limit =
        scope === "version" ? VERSION_STDERR_BYTES : CONNECTOR_LIMITS.providerOutputBytes;
      if (stderrBytes > limit) queue.fail(new OutputFailure());
    });
    (child.stderr as Readable).once("error", () => queue.fail(new OutputFailure()));
    invocation.providerInput.once("error", () => queue.fail(new ProcessEnded()));
    invocation.control.once("error", () => queue.fail(new ProcessEnded()));
    invocation.owner.once("error", () => queue.fail(new ProcessEnded()));
    child.once("error", () => queue.fail(new ProcessEnded()));
    child.once("close", () => {
      queue.push({ source: "monitor_close" });
      invocation.monitorClosed = true;
    });
    return invocation;
  }

  async #nextUntil(
    invocation: Invocation,
    deadlineUnixMs: number,
    realFallbackMs?: number,
  ): Promise<WireEvent> {
    const waiting = invocation.queue.wait();
    const delayMs = Math.max(0, deadlineUnixMs - this.#clock.nowMs());
    const clockTimer = timerPromise(this.#clock, delayMs);
    let realTimer: NodeJS.Timeout | undefined;
    const timeout = Symbol("timeout");
    const candidates: Promise<WireEvent | symbol>[] = [
      waiting.promise,
      clockTimer.promise.then(() => timeout),
    ];
    if (realFallbackMs !== undefined) {
      candidates.push(
        new Promise<symbol>((resolve) => {
          realTimer = setTimeout(() => resolve(timeout), realFallbackMs);
        }),
      );
    }
    let result =
      delayMs === 0 && this.options.spawnMonitorForTest !== undefined
        ? timeout
        : await Promise.race(candidates);
    if (result === timeout && this.options.spawnMonitorForTest !== undefined) {
      let graceTimer: NodeJS.Timeout | undefined;
      result = await Promise.race([
        waiting.promise,
        new Promise<symbol>((resolve) => {
          graceTimer = setTimeout(() => resolve(timeout), 100);
        }),
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    clockTimer.cancel();
    if (realTimer !== undefined) clearTimeout(realTimer);
    if (result === timeout) {
      waiting.cancel();
      throw new DeadlineFailure();
    }
    return result as WireEvent;
  }

  async #nextProvider(
    invocation: Invocation,
    deadlineUnixMs: number,
    realFallbackMs?: number,
  ): Promise<Extract<WireEvent, { source: "provider" }>> {
    for (;;) {
      const event = await this.#nextUntil(invocation, deadlineUnixMs, realFallbackMs);
      if (event.source === "provider") return event;
      await this.#handleLifecycle(invocation, event);
      if (invocation.lifecycleState === "exited") throw new ProcessEnded();
    }
  }

  async #awaitInterruptedExit(invocation: Invocation, deadlineUnixMs: number): Promise<never> {
    for (;;) {
      const event = await this.#nextUntil(invocation, deadlineUnixMs, STARTUP_TIMEOUT_MS);
      if (event.source === "provider" || event.source === "provider_end") continue;
      await this.#handleLifecycle(invocation, event);
      if (invocation.lifecycleState === "exited") throw new ProcessEnded();
    }
  }

  async #expectLifecycle(
    invocation: Invocation,
    expected: "ready" | "child_started" | "child_exited",
    deadlineUnixMs: number,
  ): Promise<void> {
    for (;;) {
      const event = await this.#nextUntil(invocation, deadlineUnixMs, STARTUP_TIMEOUT_MS);
      if (event.source === "provider") throw new ProtocolFailure();
      await this.#handleLifecycle(invocation, event);
      if (
        (expected === "ready" && invocation.lifecycleState === "ready") ||
        (expected === "child_started" && invocation.lifecycleState === "started") ||
        (expected === "child_exited" && invocation.lifecycleState === "exited")
      ) {
        return;
      }
    }
  }

  async #handleLifecycle(invocation: Invocation, event: WireEvent): Promise<void> {
    if (event.source !== "lifecycle") throw new ProcessEnded();
    const record = event.record;
    if (record.type === "ready") {
      if (!hasExactKeys(record, ["type"]) || invocation.lifecycleState !== "launched") {
        throw new ProtocolFailure();
      }
      invocation.lifecycleState = "ready";
      this.#observe(invocation.scope, "ready");
      return;
    }
    if (record.type === "child_started") {
      if (!hasExactKeys(record, ["type"]) || invocation.lifecycleState !== "ready") {
        throw new ProtocolFailure();
      }
      invocation.lifecycleState = "started";
      this.#observe(invocation.scope, "child_started");
      return;
    }
    if (record.type === "child_exited") {
      const code = record.code;
      const signal = record.signal;
      if (
        !hasExactKeys(record, ["type", "code", "signal"]) ||
        invocation.lifecycleState !== "started" ||
        !(
          (Number.isSafeInteger(code) && (code as number) >= 0 && signal === null) ||
          (code === null && Number.isSafeInteger(signal) && (signal as number) > 0)
        )
      ) {
        throw new ProtocolFailure();
      }
      invocation.lifecycleState = "exited";
      invocation.childExit = { code: code as number | null, signal: signal as number | null };
      invocation.terminalKnown = true;
      this.#observe(invocation.scope, "child_exited");
      if (invocation.scope === "turn") await this.#barrier("turn", "after_child_exited");
      return;
    }
    if (record.type === "fault") {
      if (
        !hasExactKeys(record, ["type", "code"]) ||
        ![
          "invalid_control",
          "spawn_failed",
          "stream_failed",
          "containment_failed",
          "internal_failure",
        ].includes(String(record.code))
      ) {
        throw new ProtocolFailure();
      }
      throw new ProcessEnded();
    }
    throw new ProtocolFailure();
  }

  async #writeControl(
    invocation: Invocation,
    record: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!invocation.control.writable || invocation.control.destroyed) throw new ProcessEnded();
    await new Promise<void>((resolve, reject) => {
      invocation.control.write(`${JSON.stringify(record)}\n`, "utf8", (error?: Error | null) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  async #cleanup(invocation: Invocation): Promise<boolean> {
    if (invocation.cleanupPromise !== undefined) return await invocation.cleanupPromise;
    invocation.cleanupPromise = this.#performCleanup(invocation);
    return await invocation.cleanupPromise;
  }

  async #cleanupOrThrow(invocation: Invocation): Promise<void> {
    if (!(await this.#cleanup(invocation))) throw new ContainmentFailure();
  }

  async #performCleanup(invocation: Invocation): Promise<boolean> {
    this.containmentAttempts += 1;
    const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
    if (["launched", "ready"].includes(invocation.lifecycleState)) {
      const closed = await waitReal(
        () => invocation.monitorClosed,
        Math.min(50, Math.max(0, cleanupDeadline - Date.now())),
      );
      if (closed && this.#groupProbe(invocation.pgid) === "empty") {
        this.#observe(invocation.scope, "monitor_reaped");
        this.#observe(invocation.scope, "group_empty_proved");
        if (!invocation.owner.destroyed) invocation.owner.end();
        this.#inspectCleanupQueue(invocation);
        return true;
      }
    }
    try {
      if (
        invocation.lifecycleState !== "launched" &&
        invocation.control.writable &&
        !invocation.control.destroyed
      ) {
        invocation.control.write('{"type":"contain"}\n', "utf8");
        this.#observe(invocation.scope, "contain_written");
      }
    } catch {
      // The exact PGID remains authoritative when the control pipe is gone.
    }
    this.#signal(invocation.pgid, "SIGTERM");
    this.#observe(invocation.scope, "sigterm_sent");
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(25, Math.max(0, cleanupDeadline - Date.now()))),
    );
    this.#signal(invocation.pgid, "SIGKILL");
    this.#observe(invocation.scope, "sigkill_sent");
    if (
      !(await waitReal(() => invocation.monitorClosed, Math.max(0, cleanupDeadline - Date.now())))
    ) {
      return false;
    }
    this.#observe(invocation.scope, "monitor_reaped");
    if (
      !(await waitReal(
        () => this.#groupProbe(invocation.pgid) === "empty",
        Math.max(0, cleanupDeadline - Date.now()),
      ))
    ) {
      return false;
    }
    this.#observe(invocation.scope, "group_empty_proved");
    if (!invocation.owner.destroyed) invocation.owner.end();
    this.#inspectCleanupQueue(invocation);
    return true;
  }

  #inspectCleanupQueue(invocation: Invocation): void {
    let conflict = false;
    for (;;) {
      let event: WireEvent | undefined;
      try {
        event = invocation.queue.tryNext();
      } catch {
        conflict = true;
        break;
      }
      if (event === undefined) break;
      if (event.source === "provider_end") {
        invocation.providerEnded = true;
        continue;
      }
      if (event.source === "lifecycle_end" || event.source === "monitor_close") continue;
      if (event.source === "lifecycle" && event.record.type === "child_exited") {
        const code = event.record.code;
        const signal = event.record.signal;
        if (
          hasExactKeys(event.record, ["type", "code", "signal"]) &&
          invocation.lifecycleState === "started" &&
          ((Number.isSafeInteger(code) && (code as number) >= 0 && signal === null) ||
            (code === null && Number.isSafeInteger(signal) && (signal as number) > 0))
        ) {
          invocation.lifecycleState = "exited";
          invocation.childExit = { code: code as number | null, signal: signal as number | null };
          continue;
        }
      }
      this.postTerminalDeliveries += 1;
      conflict = true;
    }
    if (invocation.scope === "turn" && !invocation.providerEnded) conflict = true;
    invocation.cleanupConflict ||= conflict;
  }

  #groupProbe(pgid: number): "empty" | "accessible" | "denied" {
    return this.options.processGroupProbeForTest?.(pgid) ?? processGroupProbe(pgid);
  }

  #signal(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new ContainmentFailure(`${signal}:${(error as NodeJS.ErrnoException).code}`);
      }
    }
  }

  async #barrier(scope: Scope, barrier: ProcessBarrier): Promise<void> {
    if (this.options.processBarrierForTest !== undefined) {
      await this.options.processBarrierForTest({ scope, barrier });
    }
  }

  #observe(scope: Scope, observation: ProcessObservation): void {
    this.options.processObserverForTest?.({ scope, observation });
  }

  #rememberTerminal(executionId: string): void {
    this.#terminal.add(executionId);
    this.#terminalOrder.push(executionId);
    while (this.#terminalOrder.length > TERMINAL_MEMORY) {
      const removed = this.#terminalOrder.shift();
      if (removed !== undefined) this.#terminal.delete(removed);
    }
  }
}

async function createAdapter(options: AdapterOptions): Promise<ClaudeCodeAdapter> {
  if (process.platform === "win32") throw new ContainmentFailure();
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const environment = buildProviderChildEnvironment(
    platform,
    options.inheritedEnvironment,
    options.webhookTokenEnvironmentName,
  );
  const executable = await resolveExecutable(options.fixtureExecutablePath, environment);
  const canonicalExecutable = executable === null ? null : await realpath(executable);
  const identity =
    canonicalExecutable === null
      ? null
      : await executableIdentity(
          canonicalExecutable,
          options.fixtureExecutablePath === undefined
            ? canonicalExecutable
            : (executable ?? canonicalExecutable),
        );
  const adapter = new ClaudeCodeAdapter(options, environment, identity);
  let available = identity !== null && (await adapter.preflight());
  if (available && options.afterVersionProbeForTest !== undefined) {
    await options.afterVersionProbeForTest();
    available =
      identity !== null &&
      sameIdentity(identity, await executableIdentity(identity.path, identity.launchPath));
  }
  adapter.setAvailable(available);
  return adapter;
}

export async function createClaudeCodeAdapter(options: {
  readonly workingDirectory: string;
  readonly policy: Policy;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
  readonly connectorPackageVersion: string;
}): Promise<ProviderPort & { close(deadlineUnixMs?: number): Promise<void> }> {
  try {
    return await createAdapter(options);
  } catch (error) {
    if (error instanceof ContainmentFailure) connectorError("connector_shutdown_incomplete");
    throw error;
  }
}

export async function createClaudeCodeAdapterForTest(
  options: AdapterOptions,
): Promise<ProviderPort & { close(deadlineUnixMs?: number): Promise<void> }> {
  return await createAdapter(options);
}
