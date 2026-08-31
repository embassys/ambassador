import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { CONNECTOR_LIMITS, connectorError } from "../../connector-core/src/constants.js";
import { buildProviderChildEnvironment } from "../../connector-core/src/provider-boundary.js";
import {
  type ConnectorClock,
  type ProviderPort,
  SYSTEM_CLOCK,
} from "../../connector-core/src/runtime-types.js";

export const CODEX_APP_SERVER_VERSION = "0.149.0";
export const CODEX_APP_SERVER_SCHEMA_SHA256 =
  "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9";

const APP_SERVER_ARGUMENTS = ["app-server", "--listen", "stdio://", "--strict-config"] as const;
const VERSION_STDOUT = `codex-cli ${CODEX_APP_SERVER_VERSION}\n`;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_STDOUT_BYTES = 64;
const VERSION_STDERR_BYTES = 1_024;
const RAW_RECORD_BYTES = 1_048_576;
const RAW_DEPTH = 100;
const TERMINAL_GRACE_MS = 1_000;
const TERMINAL_CLEANUP_MS = 3_000;
const OWNED_TERM_WAIT_MS = 500;
const TERMINAL_EXECUTION_MEMORY = 100;

type Policy = "read-only" | "workspace-write";

interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

type SpawnAppServer = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

interface Containment {
  contain(executionId: string): Promise<boolean>;
  isEmpty(executionId: string): boolean;
}

interface AdapterOptions {
  readonly workingDirectory: string;
  readonly policy: Policy;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
  readonly connectorPackageVersion: string;
  readonly clock?: ConnectorClock;
  readonly fixtureExecutablePath?: string | null;
  readonly afterVersionProbeForTest?: () => void | Promise<void>;
  readonly spawnAppServerForTest?: SpawnAppServer;
  readonly containmentForTest?: Containment;
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
  readonly provider_turn_id?: string | null;
  readonly input_text?: string;
}

interface CancelRequest {
  readonly execution_id: string;
  readonly provider_session_id: string | null;
  readonly provider_turn_id: string | null;
  readonly reason: string;
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

interface SelectedReply {
  readonly id: string;
  readonly text: string;
  readonly item: Record<string, unknown>;
}

class ProtocolFailure extends Error {}
class OutputFailure extends Error {}
class ProcessEnded extends Error {}
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

function validBoundedString(value: unknown, maximumBytes: number): value is string {
  return (
    isUnicodeScalarString(value) &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

class StrictJsonScanner {
  #index = 0;

  constructor(private readonly source: string) {}

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
    if (depth > RAW_DEPTH) throw new ProtocolFailure();
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
      const delimiter_ = this.source[this.#index];
      this.#index += 1;
      if (delimiter_ === "}") return result;
      if (delimiter_ !== ",") throw new ProtocolFailure();
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
      const delimiter_ = this.source[this.#index];
      this.#index += 1;
      if (delimiter_ === "]") return result;
      if (delimiter_ !== ",") throw new ProtocolFailure();
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

function parseStrictRecord(bytes: Buffer): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > RAW_RECORD_BYTES) throw new ProtocolFailure();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolFailure();
  }
  const value = new StrictJsonScanner(source).parse();
  if (!isRecord(value)) throw new ProtocolFailure();
  return value;
}

interface QueueWaiter {
  resolve(value: IteratorResult<Record<string, unknown>>): void;
  reject(error: Error): void;
}

class JsonlTransport {
  readonly #queue: Record<string, unknown>[] = [];
  readonly #waiters: QueueWaiter[] = [];
  readonly #exitPromise: Promise<void>;
  #line = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #failure: Error | undefined;
  #ended = false;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.#exitPromise = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        this.#fail(error instanceof Error ? error : new ProcessEnded());
      });
      child.once("close", () => {
        if (this.#line.byteLength > 0 && this.#failure === undefined) {
          this.#fail(new ProtocolFailure());
        }
        this.#ended = true;
        for (const waiter of this.#waiters.splice(0)) {
          if (this.#failure !== undefined) waiter.reject(this.#failure);
          else waiter.resolve({ done: true, value: undefined });
        }
        resolve();
      });
    });
    child.stdout.on("data", (chunk: Buffer) => this.#stdout(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > CONNECTOR_LIMITS.providerOutputBytes) {
        this.#fail(new OutputFailure());
      }
    });
  }

  write(value: Readonly<Record<string, unknown>>): void {
    if (this.#failure !== undefined || this.#ended || !this.child.stdin.writable) {
      throw this.#failure ?? new ProcessEnded();
    }
    const bytes = `${JSON.stringify(value)}\n`;
    if (!this.child.stdin.write(bytes, "utf8")) {
      // The messages are tiny and the App Server consumes stdin continuously.
      // Backpressure here still means the bytes were accepted by Node.
    }
  }

  next(): Promise<IteratorResult<Record<string, unknown>>> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.#queue.shift() as Record<string, unknown>,
      });
    }
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  tryNext(): Record<string, unknown> | undefined {
    if (this.#failure !== undefined) throw this.#failure;
    return this.#queue.shift();
  }

  abort(error: Error): void {
    this.#fail(error);
  }

  closeStdin(): void {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
  }

  async waitForExit(): Promise<void> {
    await this.#exitPromise;
  }

  isClosed(): boolean {
    return this.#ended;
  }

  #stdout(chunk: Buffer): void {
    if (this.#failure !== undefined) return;
    this.#stdoutBytes += chunk.byteLength;
    if (this.#stdoutBytes > CONNECTOR_LIMITS.providerOutputBytes) {
      this.#fail(new OutputFailure());
      return;
    }
    this.#line = Buffer.concat([this.#line, chunk]);
    for (;;) {
      const newline = this.#line.indexOf(0x0a);
      if (newline < 0) {
        if (this.#line.byteLength > RAW_RECORD_BYTES) this.#fail(new ProtocolFailure());
        return;
      }
      const recordBytes = this.#line.subarray(0, newline);
      this.#line = this.#line.subarray(newline + 1);
      let record: Record<string, unknown>;
      try {
        record = parseStrictRecord(recordBytes);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new ProtocolFailure());
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#queue.push(record);
      else waiter.resolve({ done: false, value: record });
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#queue.splice(0);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

function timerPromise(
  clock: ConnectorClock,
  delayMs: number,
): {
  readonly promise: Promise<void>;
  cancel(): void;
} {
  let timer: unknown;
  const promise = new Promise<void>((resolve) => {
    timer = clock.setTimer(resolve, Math.max(0, delayMs));
  });
  return { promise, cancel: () => clock.clearTimer(timer) };
}

async function waitBounded<T>(
  clock: ConnectorClock,
  promise: Promise<T>,
  delayMs: number,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  const timer = timerPromise(clock, delayMs);
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    timer.promise.then(() => ({ timedOut: true as const })),
  ]);
  timer.cancel();
  return result;
}

async function resolveExecutable(
  requested: string | null | undefined,
  environment: Readonly<Record<string, string>>,
): Promise<string | null> {
  if (requested === null) return null;
  if (requested !== undefined) {
    try {
      await realpath(requested);
      return requested;
    } catch {
      return null;
    }
  }
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, "codex");
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue the one normal PATH lookup.
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
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  groupId: number | null,
  clock: ConnectorClock,
  deadlineMs: number,
): Promise<boolean> {
  return await stopOwnedUnit(child, groupId, clock, deadlineMs);
}

function processGroupId(child: ChildProcessWithoutNullStreams): number | null {
  if (process.platform === "win32") return null;
  if (child.pid === undefined || child.pid <= 0) {
    throw new ContainmentFailure("owned process group unavailable");
  }
  return child.pid;
}

function processGroupExists(groupId: number | null): boolean {
  if (groupId === null) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function childReaped(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function ownedUnitEmpty(child: ChildProcessWithoutNullStreams, groupId: number | null): boolean {
  return childReaped(child) && !processGroupExists(groupId);
}

function signalOwnedUnit(
  child: ChildProcessWithoutNullStreams,
  groupId: number | null,
  signal: NodeJS.Signals,
): void {
  if (groupId !== null) {
    try {
      process.kill(-groupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new ContainmentFailure("owned process group signal failed");
      }
    }
    return;
  }
  if (!childReaped(child)) child.kill(signal);
}

async function waitForOwnedUnitEmpty(
  child: ChildProcessWithoutNullStreams,
  groupId: number | null,
  clock: ConnectorClock,
  delayMs: number,
): Promise<boolean> {
  const cancellation = { cancelled: false };
  const observation = (async () => {
    while (!cancellation.cancelled) {
      if (ownedUnitEmpty(child, groupId)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return false;
  })();
  const result = await waitBounded(clock, observation, delayMs);
  cancellation.cancelled = true;
  return !result.timedOut && result.value;
}

async function stopOwnedUnit(
  child: ChildProcessWithoutNullStreams,
  groupId: number | null,
  clock: ConnectorClock,
  deadlineMs: number,
): Promise<boolean> {
  if (ownedUnitEmpty(child, groupId)) return true;
  if (clock.nowMs() >= deadlineMs) return false;
  signalOwnedUnit(child, groupId, "SIGTERM");
  const termWait = Math.min(OWNED_TERM_WAIT_MS, Math.max(0, deadlineMs - clock.nowMs()));
  if (await waitForOwnedUnitEmpty(child, groupId, clock, termWait)) return true;
  const remaining = Math.max(0, deadlineMs - clock.nowMs());
  if (remaining === 0) return ownedUnitEmpty(child, groupId);
  signalOwnedUnit(child, groupId, "SIGKILL");
  return await waitForOwnedUnitEmpty(child, groupId, clock, remaining);
}

async function preflight(
  identity: ExecutableIdentity,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  clock: ConnectorClock,
): Promise<boolean> {
  const child = spawn(identity.path, ["--version"], {
    cwd,
    env: { ...environment },
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("error", () => undefined);
  const groupId = processGroupId(child);
  child.stdin.end();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > VERSION_STDOUT_BYTES) overflow = true;
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > VERSION_STDERR_BYTES) overflow = true;
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", () => resolve({ code: null, signal: null }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const result = await waitBounded(clock, completion, VERSION_TIMEOUT_MS);
  if (result.timedOut) {
    const cleanupDeadline = clock.nowMs() + TERMINAL_CLEANUP_MS;
    if (!(await stopChild(child, groupId, clock, cleanupDeadline))) {
      throw new ContainmentFailure("version probe cleanup failed");
    }
    const closed = await waitBounded(
      clock,
      completion,
      Math.max(0, cleanupDeadline - clock.nowMs()),
    );
    if (closed.timedOut) throw new ContainmentFailure("version probe cleanup failed");
    return false;
  }
  const exact =
    !overflow &&
    result.value.code === 0 &&
    result.value.signal === null &&
    Buffer.concat(stdout).toString("utf8") === VERSION_STDOUT;
  if (!ownedUnitEmpty(child, groupId)) {
    const cleanupDeadline = clock.nowMs() + TERMINAL_CLEANUP_MS;
    if (!(await stopChild(child, groupId, clock, cleanupDeadline))) {
      throw new ContainmentFailure("version probe cleanup failed");
    }
    return false;
  }
  return exact;
}

function initializeRequest(version: string): Readonly<Record<string, unknown>> {
  return {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "a2a_codex_connector",
        title: "A2A Codex Connector",
        version,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: ["configWarning"],
        extensions: null,
      },
    },
  };
}

function sandboxPolicy(policy: Policy, cwd: string): Readonly<Record<string, unknown>> {
  return policy === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
}

function failedStart(executionId: string): TerminalEvent {
  return {
    event: "failed",
    execution_id: executionId,
    reason_code: "provider_start_failed",
  };
}

function uncertain(executionId: string): TerminalEvent {
  return {
    event: "uncertain",
    execution_id: executionId,
    reason_code: "provider_outcome_unknown",
  };
}

function eventMethod(record: Record<string, unknown>): string | undefined {
  return typeof record.method === "string" ? record.method : undefined;
}

function responseResult(record: Record<string, unknown>, id: number): unknown {
  if (record.id !== id || !hasExactKeys(record, ["id", "result"])) throw new ProtocolFailure();
  return record.result;
}

function validateId(value: unknown): value is string {
  return validBoundedString(value, CONNECTOR_LIMITS.providerIdBytes);
}

function validateTurn(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "items", "itemsView", "status"])) {
    throw new ProtocolFailure();
  }
  if (!validateId(value.id) || !Array.isArray(value.items) || value.itemsView !== "full") {
    throw new ProtocolFailure();
  }
  if (!["completed", "interrupted", "failed", "inProgress"].includes(String(value.status))) {
    throw new ProtocolFailure();
  }
  return value;
}

function validateThread(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "preview",
      "modelProvider",
      "createdAt",
      "updatedAt",
      "status",
      "cwd",
      "cliVersion",
      "source",
      "sessionId",
      "turns",
      "ephemeral",
      "projectId",
    ]) ||
    !validateId(value.id) ||
    !isUnicodeScalarString(value.cwd) ||
    !Array.isArray(value.turns) ||
    value.ephemeral !== false
  ) {
    throw new ProtocolFailure();
  }
  return value;
}

function validateThreadSettings(
  result: unknown,
  cwd: string,
  expectedThreadId?: string,
): Record<string, unknown> {
  if (
    !isRecord(result) ||
    !hasExactKeys(result, [
      "thread",
      "model",
      "modelProvider",
      "cwd",
      "approvalPolicy",
      "approvalsReviewer",
      "sandbox",
    ]) ||
    result.cwd !== cwd ||
    result.approvalPolicy !== "never" ||
    result.approvalsReviewer !== "user" ||
    !isRecord(result.sandbox) ||
    !hasExactKeys(result.sandbox, ["type", "networkAccess"]) ||
    result.sandbox.type !== "readOnly" ||
    result.sandbox.networkAccess !== false
  ) {
    throw new ProtocolFailure();
  }
  const thread = validateThread(result.thread);
  if (thread.cwd !== cwd || (expectedThreadId !== undefined && thread.id !== expectedThreadId)) {
    throw new ProtocolFailure();
  }
  return thread;
}

interface ActiveInvocation {
  readonly executionId: string;
  readonly request: InvocationRequest;
  readonly transport: JsonlTransport;
  readonly processGroupId: number | null;
  sessionId: string | null;
  turnId: string | null;
  turnWritten: boolean;
  terminal: boolean;
  cancellationRequested: boolean;
  interruptRequestId: number | null;
  cancellationTimer: unknown;
  teardownPromise: Promise<void> | null;
  readonly deltas: Map<string, string>;
  readonly completedItems: Map<string, Record<string, unknown>>;
  approvalPending: boolean;
  normalizedEvents: number;
}

class CodexAppServerAdapter implements ProviderPort {
  readonly spawnRecord: ProviderPort["spawnRecord"];
  readonly #clock: ConnectorClock;
  readonly #active = new Map<string, ActiveInvocation>();
  readonly #terminalExecutions = new Set<string>();
  #closed = false;
  #containmentAttempts = 0;
  #postTerminalDeliveries = 0;

  constructor(
    private readonly options: AdapterOptions,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly identity: ExecutableIdentity | null,
    private readonly available: boolean,
  ) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.spawnRecord = {
      executable: identity?.path ?? "codex",
      arguments: [...APP_SERVER_ARGUMENTS],
      environment: { ...environment },
      shell: false,
    };
  }

  get containmentAttempts(): number {
    return this.#containmentAttempts;
  }

  get postTerminalDeliveries(): number {
    return this.#postTerminalDeliveries;
  }

  start(request: Record<string, unknown>): AsyncIterable<unknown> {
    return this.#invoke(request as unknown as InvocationRequest, "start");
  }

  resume(request: Record<string, unknown>): AsyncIterable<unknown> {
    return this.#invoke(request as unknown as InvocationRequest, "resume");
  }

  recover(request: Record<string, unknown>): AsyncIterable<unknown> {
    return this.#invoke(request as unknown as InvocationRequest, "recover");
  }

  async cancel(request: Record<string, unknown>): Promise<CancelResult> {
    const value = request as unknown as CancelRequest;
    const invocation = this.#active.get(value.execution_id);
    if (invocation === undefined) {
      return this.#terminalExecutions.has(value.execution_id)
        ? { status: "already_terminal" }
        : { status: "not_found" };
    }
    if (invocation.terminal) return { status: "already_terminal" };
    if (
      invocation.turnId === null ||
      value.provider_turn_id !== invocation.turnId ||
      value.provider_session_id !== invocation.sessionId
    ) {
      return { status: "not_found" };
    }
    if (!invocation.cancellationRequested) {
      invocation.cancellationRequested = true;
      invocation.interruptRequestId = 4;
      try {
        invocation.transport.write({
          id: 4,
          method: "turn/interrupt",
          params: { threadId: invocation.sessionId, turnId: invocation.turnId },
        });
      } catch {
        // The stream translates this dispatch-sensitive loss to uncertainty.
      }
      invocation.cancellationTimer = this.#clock.setTimer(
        () => {
          void this.#expireCancellation(invocation);
        },
        Math.max(
          0,
          invocation.request.deadline_unix_ms +
            CONNECTOR_LIMITS.cancellationGraceMs -
            this.#clock.nowMs(),
        ),
      );
    }
    return { status: "cancel_requested" };
  }

  async #expireCancellation(invocation: ActiveInvocation): Promise<void> {
    if (invocation.terminal) return;
    const contained = await this.#containAndProve(
      invocation,
      this.#clock.nowMs() + TERMINAL_CLEANUP_MS,
    );
    invocation.transport.abort(contained ? new ProcessEnded() : new ContainmentFailure());
  }

  async contain(executionId: string): Promise<boolean> {
    const invocation = this.#active.get(executionId);
    if (invocation === undefined) return true;
    return await this.#containAndProve(invocation, this.#clock.nowMs() + TERMINAL_CLEANUP_MS);
  }

  async close(deadlineUnixMs?: number): Promise<void> {
    this.#closed = true;
    const cleanupDeadline = deadlineUnixMs ?? this.#clock.nowMs() + TERMINAL_CLEANUP_MS;
    await Promise.all(
      [...this.#active.values()].map(async (invocation) => {
        invocation.transport.closeStdin();
        if (
          !(await this.#unitEmpty(invocation)) &&
          !(await this.#containAndProve(invocation, cleanupDeadline))
        ) {
          throw new ContainmentFailure("provider unit cleanup failed");
        }
      }),
    );
  }

  async *#invoke(
    request: InvocationRequest,
    operation: "start" | "resume" | "recover",
  ): AsyncGenerator<unknown> {
    if (operation === "recover" && request.provider_turn_id === null) {
      yield uncertain(request.execution_id);
      return;
    }
    if (this.#closed || !(await this.#canInvoke())) {
      yield operation === "recover"
        ? uncertain(request.execution_id)
        : failedStart(request.execution_id);
      return;
    }
    let invocation: ActiveInvocation | undefined;
    try {
      invocation = this.#spawnInvocation(request);
      await this.#handshake(invocation);
      if (operation === "recover") {
        const terminal = await this.#recoverTerminal(invocation);
        await this.#teardownOnce(invocation, terminal);
        invocation.terminal = true;
        this.#rememberTerminal(invocation.executionId);
        yield terminal;
        return;
      }

      const requestedSession = operation === "resume" ? request.provider_session_id : undefined;
      const session = this.#threadPhase(invocation, operation, requestedSession);
      for await (const event of session) yield event;
      const terminal = yield* this.#turnPhase(invocation);
      await this.#teardownOnce(invocation, terminal);
      invocation.terminal = true;
      this.#rememberTerminal(invocation.executionId);
      yield terminal;
    } catch (error) {
      if (invocation !== undefined) {
        try {
          await this.#teardownOnce(invocation, undefined);
        } catch (teardownError) {
          if (teardownError instanceof ContainmentFailure || !(await this.#unitEmpty(invocation))) {
            throw teardownError;
          }
        }
      }
      if (invocation === undefined || !invocation.terminal) {
        const preTurn = invocation === undefined || !invocation.turnWritten;
        const terminal =
          preTurn && !(error instanceof OutputFailure)
            ? operation === "recover"
              ? uncertain(request.execution_id)
              : failedStart(request.execution_id)
            : uncertain(request.execution_id);
        if (invocation !== undefined) invocation.terminal = true;
        this.#rememberTerminal(request.execution_id);
        yield terminal;
      }
    } finally {
      if (invocation !== undefined) {
        this.#clock.clearTimer(invocation.cancellationTimer);
        if (!invocation.terminal) await this.#teardownOnce(invocation, undefined);
        this.#active.delete(invocation.executionId);
      }
    }
  }

  #rememberTerminal(executionId: string): void {
    this.#terminalExecutions.add(executionId);
    while (this.#terminalExecutions.size > TERMINAL_EXECUTION_MEMORY) {
      const oldest = this.#terminalExecutions.values().next().value;
      if (oldest === undefined) return;
      this.#terminalExecutions.delete(oldest);
    }
  }

  async #canInvoke(): Promise<boolean> {
    return (
      this.available &&
      this.identity !== null &&
      sameIdentity(this.identity, await executableIdentity(this.identity.path))
    );
  }

  #spawnInvocation(request: InvocationRequest): ActiveInvocation {
    if (this.identity === null) throw new ProcessEnded();
    const spawnAppServer =
      this.options.spawnAppServerForTest ??
      ((executable: string, arguments_: readonly string[], options: SpawnOptions) =>
        spawn(executable, [...arguments_], {
          cwd: options.cwd,
          env: { ...options.env },
          detached: options.detached,
          shell: options.shell,
          stdio: [...options.stdio],
          windowsHide: true,
        }));
    const child = spawnAppServer(this.identity.launchPath, APP_SERVER_ARGUMENTS, {
      cwd: this.options.workingDirectory,
      env: this.environment,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transport = new JsonlTransport(child);
    const groupId = processGroupId(child);
    const invocation: ActiveInvocation = {
      executionId: request.execution_id,
      request,
      transport,
      processGroupId: groupId,
      sessionId: null,
      turnId: null,
      turnWritten: false,
      terminal: false,
      cancellationRequested: false,
      interruptRequestId: null,
      cancellationTimer: undefined,
      teardownPromise: null,
      deltas: new Map(),
      completedItems: new Map(),
      approvalPending: false,
      normalizedEvents: 0,
    };
    this.#active.set(request.execution_id, invocation);
    return invocation;
  }

  async #next(invocation: ActiveInvocation): Promise<IteratorResult<Record<string, unknown>>> {
    const pending = invocation.transport.next();
    const bounded = await waitBounded(
      this.#clock,
      pending,
      Math.max(0, invocation.request.deadline_unix_ms - this.#clock.nowMs()),
    );
    if (bounded.timedOut) {
      if (!invocation.cancellationRequested) throw new ProcessEnded();
      return await pending;
    }
    return bounded.value;
  }

  async #handshake(invocation: ActiveInvocation): Promise<void> {
    invocation.transport.write(initializeRequest(this.options.connectorPackageVersion));
    const next = await this.#next(invocation);
    if (next.done) throw new ProtocolFailure();
    const result = responseResult(next.value, 1);
    if (!isRecord(result) || !hasExactKeys(result, [])) throw new ProtocolFailure();
    if (invocation.transport.tryNext() !== undefined) throw new ProtocolFailure();
    invocation.transport.write({ method: "initialized" });
  }

  async *#threadPhase(
    invocation: ActiveInvocation,
    operation: "start" | "resume",
    requestedSession: string | null | undefined,
  ): AsyncGenerator<unknown> {
    const params =
      operation === "start"
        ? {
            cwd: this.options.workingDirectory,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            ephemeral: false,
            serviceName: "a2a_codex_connector",
          }
        : {
            threadId: requestedSession,
            cwd: this.options.workingDirectory,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
          };
    invocation.transport.write({ id: 2, method: `thread/${operation}`, params });
    let responseSeen = false;
    let bindingEmitted = false;
    while (!responseSeen || !bindingEmitted) {
      const next = await this.#next(invocation);
      if (next.done) throw new ProcessEnded();
      const record = next.value;
      if (Object.hasOwn(record, "id")) {
        const result = responseResult(record, 2);
        const thread = validateThreadSettings(
          result,
          this.options.workingDirectory,
          operation === "resume" ? (requestedSession ?? undefined) : undefined,
        );
        this.#bindSession(invocation, thread.id);
        responseSeen = true;
      } else {
        this.#handleThreadNotification(invocation, record);
      }
      if (!bindingEmitted && invocation.sessionId !== null) {
        bindingEmitted = true;
        if (operation === "start") {
          this.#normalized(invocation);
          yield {
            event: "session_bound",
            execution_id: invocation.executionId,
            provider_session_id: invocation.sessionId,
          };
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      const queued = invocation.transport.tryNext();
      if (queued === undefined) break;
      this.#handleThreadNotification(invocation, queued);
    }
  }

  #handleThreadNotification(invocation: ActiveInvocation, record: Record<string, unknown>): void {
    if (
      eventMethod(record) !== "thread/started" ||
      !hasExactKeys(record, ["method", "params"]) ||
      !isRecord(record.params) ||
      !hasExactKeys(record.params, ["thread"])
    ) {
      if (this.#ignoredNotification(invocation, record)) return;
      throw new ProtocolFailure();
    }
    const thread = validateThread(record.params.thread);
    if (thread.cwd !== this.options.workingDirectory) throw new ProtocolFailure();
    this.#bindSession(invocation, thread.id);
  }

  #bindSession(invocation: ActiveInvocation, value: unknown): void {
    if (!validateId(value)) throw new ProtocolFailure();
    if (invocation.sessionId !== null && invocation.sessionId !== value)
      throw new ProtocolFailure();
    invocation.sessionId = value;
  }

  async *#turnPhase(invocation: ActiveInvocation): AsyncGenerator<unknown, TerminalEvent> {
    if (invocation.sessionId === null || !isUnicodeScalarString(invocation.request.input_text)) {
      throw new ProtocolFailure();
    }
    invocation.transport.write({
      id: 3,
      method: "turn/start",
      params: {
        threadId: invocation.sessionId,
        input: [{ type: "text", text: invocation.request.input_text, text_elements: [] }],
        cwd: this.options.workingDirectory,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(this.options.policy, this.options.workingDirectory),
      },
    });
    invocation.turnWritten = true;
    let responseSeen = false;
    let bindingEmitted = false;
    let terminal: TerminalEvent | undefined;
    const pendingRecords: Record<string, unknown>[] = [];
    const buffered: unknown[] = [];
    for (;;) {
      const next = await this.#next(invocation);
      if (next.done) throw new ProcessEnded();
      const record = next.value;
      const method = eventMethod(record);
      if (Object.hasOwn(record, "id") && method !== undefined) {
        if (invocation.turnId === null) pendingRecords.push(record);
        else {
          const normalized = this.#handleTurnNotification(invocation, record);
          if (normalized !== undefined) buffered.push(normalized);
        }
      } else if (Object.hasOwn(record, "id")) {
        if (record.id === 3) {
          const result = responseResult(record, 3);
          if (!isRecord(result) || !hasExactKeys(result, ["turn"])) throw new ProtocolFailure();
          const turn = validateTurn(result.turn);
          this.#bindTurn(invocation, turn.id);
          responseSeen = true;
        } else {
          this.#handleInterruptResponse(invocation, record);
        }
      } else {
        if (
          invocation.turnId === null &&
          [
            "item/agentMessage/delta",
            "item/completed",
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
          ].includes(method ?? "")
        ) {
          pendingRecords.push(record);
        } else {
          const normalized = this.#handleTurnNotification(invocation, record);
          if (this.#terminalEvent(normalized)) {
            if (terminal !== undefined) throw new ProtocolFailure();
            terminal = normalized;
          } else if (normalized !== undefined) buffered.push(normalized);
        }
      }
      if (!bindingEmitted && invocation.turnId !== null) {
        bindingEmitted = true;
        this.#normalized(invocation);
        yield {
          event: "turn_bound",
          execution_id: invocation.executionId,
          provider_turn_id: invocation.turnId,
        };
        for (const pending of pendingRecords.splice(0)) {
          const normalized = this.#handleTurnNotification(invocation, pending);
          if (this.#terminalEvent(normalized)) {
            if (terminal !== undefined) throw new ProtocolFailure();
            terminal = normalized;
          } else if (normalized !== undefined) buffered.push(normalized);
        }
        for (const event of buffered.splice(0)) {
          this.#normalized(invocation);
          yield event;
        }
      } else if (bindingEmitted) {
        for (const event of buffered.splice(0)) {
          this.#normalized(invocation);
          yield event;
        }
      }
      if (terminal !== undefined && responseSeen && bindingEmitted) {
        this.#normalized(invocation);
        return terminal;
      }
    }
  }

  #normalized(invocation: ActiveInvocation): void {
    invocation.normalizedEvents += 1;
    if (invocation.normalizedEvents > CONNECTOR_LIMITS.normalizedEvents) throw new OutputFailure();
  }

  #handleTurnNotification(
    invocation: ActiveInvocation,
    record: Record<string, unknown>,
  ): unknown | undefined {
    const method = eventMethod(record);
    if (method === "thread/started") {
      this.#handleThreadNotification(invocation, record);
      return undefined;
    }
    if (method === "turn/started") {
      if (
        !hasExactKeys(record, ["method", "params"]) ||
        !isRecord(record.params) ||
        !hasExactKeys(record.params, ["threadId", "turn"]) ||
        record.params.threadId !== invocation.sessionId
      ) {
        throw new ProtocolFailure();
      }
      const turn = validateTurn(record.params.turn);
      this.#bindTurn(invocation, turn.id);
      return undefined;
    }
    if (method === "turn/completed") {
      if (invocation.approvalPending && !invocation.cancellationRequested) {
        throw new ProtocolFailure();
      }
      return this.#terminalFromTurn(invocation, record);
    }
    if (method === "item/agentMessage/delta") {
      return this.#agentDelta(invocation, record);
    }
    if (method === "item/completed") {
      this.#completedItem(invocation, record);
      return undefined;
    }
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(method ?? "")
    ) {
      return this.#approvalRequest(invocation, record);
    }
    if (method === "serverRequest/resolved") throw new ProtocolFailure();
    if (this.#ignoredNotification(invocation, record)) return undefined;
    throw new ProtocolFailure();
  }

  #approvalRequest(invocation: ActiveInvocation, record: Record<string, unknown>): unknown {
    if (
      invocation.approvalPending ||
      !hasExactKeys(record, ["id", "method", "params"]) ||
      !isRecord(record.params) ||
      record.params.threadId !== invocation.sessionId ||
      record.params.turnId !== invocation.turnId ||
      !validateId(record.params.itemId)
    ) {
      throw new ProtocolFailure();
    }
    let approvalRequestId: string;
    if (typeof record.id === "number" && Number.isSafeInteger(record.id)) {
      approvalRequestId = `n:${record.id}`;
    } else if (isUnicodeScalarString(record.id)) {
      approvalRequestId = `s:${record.id}`;
    } else {
      throw new ProtocolFailure();
    }
    if (!validBoundedString(approvalRequestId, CONNECTOR_LIMITS.providerIdBytes)) {
      throw new ProtocolFailure();
    }
    invocation.approvalPending = true;
    return {
      event: "approval_required",
      execution_id: invocation.executionId,
      approval_request_id: approvalRequestId,
    };
  }

  #agentDelta(invocation: ActiveInvocation, record: Record<string, unknown>): unknown {
    if (
      !hasExactKeys(record, ["method", "params"]) ||
      !isRecord(record.params) ||
      !hasExactKeys(record.params, ["threadId", "turnId", "itemId", "delta"]) ||
      record.params.threadId !== invocation.sessionId ||
      record.params.turnId !== invocation.turnId ||
      !validateId(record.params.itemId) ||
      !validBoundedString(record.params.delta, CONNECTOR_LIMITS.finalReplyBytes)
    ) {
      throw new ProtocolFailure();
    }
    const prior = invocation.deltas.get(record.params.itemId) ?? "";
    const combined = prior + record.params.delta;
    if (
      !isUnicodeScalarString(combined) ||
      Buffer.byteLength(combined) > CONNECTOR_LIMITS.finalReplyBytes
    ) {
      throw new ProtocolFailure();
    }
    invocation.deltas.set(record.params.itemId, combined);
    return {
      event: "progress",
      execution_id: invocation.executionId,
      text: record.params.delta,
    };
  }

  #completedItem(invocation: ActiveInvocation, record: Record<string, unknown>): void {
    if (
      !hasExactKeys(record, ["method", "params"]) ||
      !isRecord(record.params) ||
      !hasExactKeys(record.params, ["threadId", "turnId", "completedAtMs", "item"]) ||
      record.params.threadId !== invocation.sessionId ||
      record.params.turnId !== invocation.turnId ||
      !Number.isSafeInteger(record.params.completedAtMs) ||
      !isRecord(record.params.item) ||
      !validateId(record.params.item.id)
    ) {
      throw new ProtocolFailure();
    }
    const existing = invocation.completedItems.get(record.params.item.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record.params.item)) {
      throw new ProtocolFailure();
    }
    invocation.completedItems.set(record.params.item.id, record.params.item);
  }

  #bindTurn(invocation: ActiveInvocation, value: unknown): void {
    if (!validateId(value)) throw new ProtocolFailure();
    if (invocation.turnId !== null && invocation.turnId !== value) throw new ProtocolFailure();
    invocation.turnId = value;
  }

  #terminalFromTurn(invocation: ActiveInvocation, record: Record<string, unknown>): TerminalEvent {
    if (
      !hasExactKeys(record, ["method", "params"]) ||
      !isRecord(record.params) ||
      !hasExactKeys(record.params, ["threadId", "turn"]) ||
      record.params.threadId !== invocation.sessionId
    ) {
      throw new ProtocolFailure();
    }
    const turn = validateTurn(record.params.turn);
    this.#bindTurn(invocation, turn.id);
    if (turn.status === "failed") {
      return {
        event: "failed",
        execution_id: invocation.executionId,
        reason_code: "provider_execution_failed",
      };
    }
    if (turn.status !== "completed") return uncertain(invocation.executionId);
    const reply = this.#selectReply(turn.items);
    if (reply === null || !this.#corroborates(invocation, reply)) {
      return {
        event: "failed",
        execution_id: invocation.executionId,
        reason_code: "provider_result_invalid",
      };
    }
    return { event: "reply", execution_id: invocation.executionId, text: reply.text };
  }

  #selectReply(items: unknown): SelectedReply | null {
    if (!Array.isArray(items)) return null;
    const final: SelectedReply[] = [];
    const compatibility: SelectedReply[] = [];
    for (const item of items) {
      if (!isRecord(item) || item.type !== "agentMessage") continue;
      if (!hasExactKeys(item, ["id", "type", "phase", "text"])) return null;
      if (
        !validateId(item.id) ||
        !validBoundedString(item.text, CONNECTOR_LIMITS.finalReplyBytes)
      ) {
        return null;
      }
      const selected = { id: item.id, text: item.text, item };
      if (item.phase === "final_answer") final.push(selected);
      else if (item.phase === null) compatibility.push(selected);
      else if (item.phase !== "commentary") return null;
    }
    if (final.length === 1) return final[0] as SelectedReply;
    if (final.length === 0 && compatibility.length === 1) return compatibility[0] as SelectedReply;
    return null;
  }

  #corroborates(invocation: ActiveInvocation, reply: SelectedReply): boolean {
    const completed = invocation.completedItems.get(reply.id);
    if (completed !== undefined && JSON.stringify(completed) !== JSON.stringify(reply.item)) {
      return false;
    }
    const delta = invocation.deltas.get(reply.id);
    return delta === undefined || delta === reply.text;
  }

  #ignoredNotification(invocation: ActiveInvocation, record: Record<string, unknown>): boolean {
    const method = eventMethod(record);
    if (method === "configWarning") throw new ProtocolFailure();
    if (!["warning", "turn/diff/updated"].includes(method ?? "")) return false;
    if (!hasExactKeys(record, ["method", "params"]) || !isRecord(record.params)) {
      throw new ProtocolFailure();
    }
    if (
      Object.hasOwn(record.params, "threadId") &&
      record.params.threadId !== null &&
      record.params.threadId !== invocation.sessionId
    ) {
      throw new ProtocolFailure();
    }
    if (
      Object.hasOwn(record.params, "turnId") &&
      record.params.turnId !== null &&
      record.params.turnId !== invocation.turnId
    ) {
      throw new ProtocolFailure();
    }
    return true;
  }

  #handleInterruptResponse(invocation: ActiveInvocation, record: Record<string, unknown>): void {
    if (invocation.interruptRequestId === null || record.id !== invocation.interruptRequestId) {
      throw new ProtocolFailure();
    }
    const result = responseResult(record, invocation.interruptRequestId);
    if (!isRecord(result) || !hasExactKeys(result, [])) throw new ProtocolFailure();
    invocation.interruptRequestId = null;
  }

  #terminalEvent(value: unknown): value is TerminalEvent {
    return isRecord(value) && ["reply", "failed", "uncertain"].includes(String(value.event));
  }

  async #recoverTerminal(invocation: ActiveInvocation): Promise<TerminalEvent> {
    invocation.sessionId = invocation.request.provider_session_id ?? null;
    invocation.turnId = invocation.request.provider_turn_id ?? null;
    if (invocation.sessionId === null || invocation.turnId === null)
      return uncertain(invocation.executionId);
    invocation.transport.write({
      id: 2,
      method: "thread/read",
      params: { threadId: invocation.sessionId, includeTurns: true },
    });
    let next: IteratorResult<Record<string, unknown>>;
    try {
      next = await this.#next(invocation);
    } catch {
      return uncertain(invocation.executionId);
    }
    if (next.done) return uncertain(invocation.executionId);
    try {
      const result = responseResult(next.value, 2);
      if (!isRecord(result) || !hasExactKeys(result, ["thread"])) throw new ProtocolFailure();
      const thread = validateThread(result.thread);
      if (thread.id !== invocation.sessionId) throw new ProtocolFailure();
      const matches = (thread.turns as unknown[]).filter(
        (turn) => isRecord(turn) && turn.id === invocation.turnId,
      );
      if (matches.length !== 1) return uncertain(invocation.executionId);
      const turn = validateTurn(matches[0]);
      if (turn.status === "failed") {
        return {
          event: "failed",
          execution_id: invocation.executionId,
          reason_code: "provider_execution_failed",
        };
      }
      if (turn.status !== "completed") return uncertain(invocation.executionId);
      const reply = this.#selectReply(turn.items);
      return reply === null
        ? {
            event: "failed",
            execution_id: invocation.executionId,
            reason_code: "provider_result_invalid",
          }
        : { event: "reply", execution_id: invocation.executionId, text: reply.text };
    } catch {
      return uncertain(invocation.executionId);
    }
  }

  #teardownOnce(invocation: ActiveInvocation, candidate: TerminalEvent | undefined): Promise<void> {
    invocation.teardownPromise ??= this.#teardown(invocation, candidate);
    return invocation.teardownPromise;
  }

  async #teardown(
    invocation: ActiveInvocation,
    candidate: TerminalEvent | undefined,
  ): Promise<void> {
    invocation.transport.closeStdin();
    const cleanupDeadline = this.#clock.nowMs() + TERMINAL_CLEANUP_MS;
    const gracefulWait = { cancelled: false };
    const first = await waitBounded(
      this.#clock,
      this.#waitForUnitEmpty(invocation, gracefulWait),
      TERMINAL_GRACE_MS,
    );
    gracefulWait.cancelled = true;
    if (!first.timedOut && first.value) {
      this.#inspectLate(invocation, candidate);
      return;
    }
    if (!(await this.#containAndProve(invocation, cleanupDeadline))) {
      throw new ContainmentFailure("provider unit cleanup failed");
    }
    this.#inspectLate(invocation, candidate);
  }

  #inspectLate(invocation: ActiveInvocation, candidate: TerminalEvent | undefined): void {
    for (;;) {
      let record: Record<string, unknown> | undefined;
      try {
        record = invocation.transport.tryNext();
      } catch (error) {
        if (candidate !== undefined) throw error;
        return;
      }
      if (record === undefined) return;
      this.#postTerminalDeliveries += 1;
      if (candidate !== undefined) throw new ProtocolFailure();
    }
  }

  async #waitForUnitEmpty(
    invocation: ActiveInvocation,
    cancellation: { cancelled: boolean },
  ): Promise<boolean> {
    while (!cancellation.cancelled) {
      if (await this.#unitEmpty(invocation)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async #unitEmpty(invocation: ActiveInvocation): Promise<boolean> {
    if (this.options.containmentForTest !== undefined) {
      const providerEmpty = this.options.containmentForTest.isEmpty(invocation.executionId);
      return invocation.transport.isClosed() && providerEmpty;
    }
    return (
      invocation.transport.isClosed() &&
      ownedUnitEmpty(invocation.transport.child, invocation.processGroupId)
    );
  }

  async #containAndProve(invocation: ActiveInvocation, deadlineMs: number): Promise<boolean> {
    if (await this.#unitEmpty(invocation)) return true;
    if (this.#clock.nowMs() >= deadlineMs) return false;
    this.#containmentAttempts += 1;
    let contained: boolean;
    if (this.options.containmentForTest !== undefined) {
      contained = await this.options.containmentForTest.contain(invocation.executionId);
    } else {
      contained = await stopOwnedUnit(
        invocation.transport.child,
        invocation.processGroupId,
        this.#clock,
        deadlineMs,
      );
    }
    if (contained && (await this.#unitEmpty(invocation))) return true;
    const cleanupWait = { cancelled: false };
    const remaining = await waitBounded(
      this.#clock,
      this.#waitForUnitEmpty(invocation, cleanupWait),
      Math.max(0, deadlineMs - this.#clock.nowMs()),
    );
    cleanupWait.cancelled = true;
    return !remaining.timedOut && remaining.value;
  }
}

async function createAdapter(options: AdapterOptions): Promise<CodexAppServerAdapter> {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const environment = buildProviderChildEnvironment(
    platform,
    options.inheritedEnvironment,
    options.webhookTokenEnvironmentName,
  );
  const clock = options.clock ?? SYSTEM_CLOCK;
  const executable = await resolveExecutable(options.fixtureExecutablePath, environment);
  const canonicalExecutable = executable === null ? null : await realpath(executable);
  const identity =
    canonicalExecutable === null
      ? null
      : await executableIdentity(canonicalExecutable, executable ?? canonicalExecutable);
  let available = identity !== null;
  if (identity !== null)
    available = await preflight(identity, options.workingDirectory, environment, clock);
  if (available && options.afterVersionProbeForTest !== undefined) {
    await options.afterVersionProbeForTest();
    available =
      identity !== null && sameIdentity(identity, await executableIdentity(identity.path));
  }
  return new CodexAppServerAdapter(options, environment, identity, available);
}

export async function createCodexAppServerAdapter(options: {
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

export async function createCodexAppServerAdapterForTest(
  options: AdapterOptions,
): Promise<ProviderPort & { close(deadlineUnixMs?: number): Promise<void> }> {
  return await createAdapter(options);
}
