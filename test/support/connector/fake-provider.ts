import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  FakeProviderRequest,
  FakeProviderSpawnRecord,
  FakeProviderStep,
  ProviderCancelRequest,
  ProviderCancelResult,
} from "./fake-provider-types.js";

const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_EXECUTIONS = 2;

interface PullEnvelope {
  channel: "pull_result";
  request_id: number;
  done: boolean;
  terminal?: boolean;
  value?: unknown;
}

interface CancelEnvelope {
  channel: "cancel_result";
  request_id: number;
  value: ProviderCancelResult;
}

interface ProtocolErrorEnvelope {
  channel: "protocol_error";
  code: string;
}

type WorkerEnvelope = PullEnvelope | CancelEnvelope | ProtocolErrorEnvelope;

interface PullWaiter {
  executionId: string;
  resolve: (value: PullOutcome) => void;
  reject: (error: Error) => void;
}

interface CancelWaiter {
  resolve: (value: ProviderCancelResult) => void;
  reject: (error: Error) => void;
}

interface PullOutcome {
  result: IteratorResult<unknown>;
  terminal: boolean;
}

export class FakeProviderExitedError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super("fake provider process exited");
    this.name = "FakeProviderExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class FakeProviderInvocation implements AsyncIterable<unknown> {
  #ended = false;
  #pulling = false;
  #error: Error | undefined;

  constructor(
    readonly executionId: string,
    private readonly requestPull: (executionId: string) => Promise<PullOutcome>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return { next: async () => await this.next() };
  }

  async next(): Promise<IteratorResult<unknown>> {
    if (this.#error !== undefined) throw this.#error;
    if (this.#ended) return { done: true, value: undefined };
    if (this.#pulling) throw new Error("fake provider pull is already pending");
    this.#pulling = true;
    try {
      const outcome = await this.requestPull(this.executionId);
      if (outcome.result.done || outcome.terminal) this.#ended = true;
      return outcome.result;
    } finally {
      this.#pulling = false;
    }
  }

  fail(error: Error): void {
    if (this.#ended || this.#error !== undefined) return;
    this.#error = error;
  }
}

export interface ScriptedFakeProvider {
  readonly requests: readonly FakeProviderRequest[];
  readonly pulls: readonly string[];
  readonly cancellations: readonly ProviderCancelRequest[];
  readonly activeExecutionCount: number;
  readonly spawnRecord: FakeProviderSpawnRecord;
  readonly stderrByteCount: number;
  readonly closed: boolean;
  invoke(request: FakeProviderRequest, script: readonly FakeProviderStep[]): FakeProviderInvocation;
  cancel(request: ProviderCancelRequest): Promise<ProviderCancelResult>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

class ProviderFixture implements ScriptedFakeProvider {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #invocations = new Map<string, FakeProviderInvocation>();
  readonly #requestRecords: FakeProviderRequest[] = [];
  readonly #pullRecords: string[] = [];
  readonly #cancelRecords: ProviderCancelRequest[] = [];
  readonly #pullWaiters = new Map<number, PullWaiter>();
  readonly #cancelWaiters = new Map<number, CancelWaiter>();
  readonly #decoder = new StringDecoder("utf8");
  readonly #exitPromise: Promise<void>;
  readonly spawnRecord: FakeProviderSpawnRecord;
  #buffer = "";
  #nextRequestId = 1;
  #stderrByteCount = 0;
  #closed = false;

  constructor() {
    const worker = fileURLToPath(new URL("./fake-provider-worker.js", import.meta.url));
    const environment = closedEnvironment();
    this.spawnRecord = {
      executable: process.execPath,
      arguments: [worker],
      environment: structuredClone(environment),
      shell: false,
    };
    this.#child = spawn(process.execPath, [worker], {
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrByteCount += chunk.byteLength;
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#child.once("exit", (code, signal) => {
        this.#closed = true;
        const error = new FakeProviderExitedError(code, signal);
        for (const invocation of this.#invocations.values()) invocation.fail(error);
        this.#invocations.clear();
        for (const waiter of this.#pullWaiters.values()) waiter.reject(error);
        this.#pullWaiters.clear();
        for (const waiter of this.#cancelWaiters.values()) waiter.reject(error);
        this.#cancelWaiters.clear();
        resolve();
      });
    });
    this.#child.once("error", () => {
      this.#failProtocol(new Error("fake provider failed to start"));
    });
  }

  get requests(): readonly FakeProviderRequest[] {
    return this.#requestRecords.map((request) => structuredClone(request));
  }

  get pulls(): readonly string[] {
    return [...this.#pullRecords];
  }

  get cancellations(): readonly ProviderCancelRequest[] {
    return this.#cancelRecords.map((request) => structuredClone(request));
  }

  get activeExecutionCount(): number {
    return this.#invocations.size;
  }

  get stderrByteCount(): number {
    return this.#stderrByteCount;
  }

  get closed(): boolean {
    return this.#closed;
  }

  invoke(
    request: FakeProviderRequest,
    script: readonly FakeProviderStep[],
  ): FakeProviderInvocation {
    assert.ok(!this.#closed, "fake provider is closed");
    assert.ok(!this.#invocations.has(request.execution_id), "execution ID is already active");
    assert.ok(
      this.#invocations.size < MAX_ACTIVE_EXECUTIONS,
      "fake provider execution capacity reached",
    );
    const invocation = new FakeProviderInvocation(
      request.execution_id,
      async (executionId) => await this.#pull(executionId),
    );
    this.#invocations.set(request.execution_id, invocation);
    this.#requestRecords.push(structuredClone(request));
    this.#send({ command: "invoke", request, script });
    return invocation;
  }

  async cancel(request: ProviderCancelRequest): Promise<ProviderCancelResult> {
    assert.ok(!this.#closed, "fake provider is closed");
    const requestId = this.#claimRequestId();
    this.#cancelRecords.push(structuredClone(request));
    const response = new Promise<ProviderCancelResult>((resolve, reject) => {
      this.#cancelWaiters.set(requestId, { resolve, reject });
    });
    this.#send({ command: "cancel", request_id: requestId, request });
    return await response;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#exitPromise;
      return;
    }
    this.#send({ command: "shutdown" });
    const timeout = setTimeout(() => this.#child.kill(), 2_000);
    timeout.unref();
    await this.#exitPromise;
    clearTimeout(timeout);
  }

  async #pull(executionId: string): Promise<PullOutcome> {
    assert.ok(!this.#closed, "fake provider is closed");
    assert.ok(this.#invocations.has(executionId), "fake provider execution is not active");
    const requestId = this.#claimRequestId();
    this.#pullRecords.push(executionId);
    const response = new Promise<PullOutcome>((resolve, reject) => {
      this.#pullWaiters.set(requestId, { executionId, resolve, reject });
    });
    this.#send({ command: "pull", request_id: requestId, execution_id: executionId });
    return await response;
  }

  #claimRequestId(): number {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return requestId;
  }

  #send(value: unknown): void {
    if (this.#closed || !this.#child.stdin.writable) throw new Error("fake provider is closed");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  #receive(chunk: Buffer): void {
    this.#buffer += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      this.#failProtocol(new Error("fake provider protocol line exceeded fixture bound"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#failProtocol(new Error("fake provider protocol was malformed"));
        return;
      }
      this.#route(parsed);
    }
  }

  #route(value: unknown): void {
    if (!isObject(value) || typeof value.channel !== "string") {
      this.#failProtocol(new Error("fake provider envelope was invalid"));
      return;
    }
    const envelope = value as unknown as WorkerEnvelope;
    if (envelope.channel === "pull_result") {
      const waiter = this.#pullWaiters.get(envelope.request_id);
      if (waiter === undefined) {
        this.#failProtocol(new Error("fake provider sent an unrequested event"));
        return;
      }
      this.#pullWaiters.delete(envelope.request_id);
      if (envelope.done || envelope.terminal === true) {
        this.#invocations.delete(waiter.executionId);
      }
      waiter.resolve({
        result: envelope.done
          ? { done: true, value: undefined }
          : { done: false, value: envelope.value },
        terminal: envelope.terminal === true,
      });
      return;
    }
    if (envelope.channel === "cancel_result") {
      const waiter = this.#cancelWaiters.get(envelope.request_id);
      if (waiter === undefined) {
        this.#failProtocol(new Error("fake provider sent an unexpected cancel result"));
        return;
      }
      this.#cancelWaiters.delete(envelope.request_id);
      waiter.resolve(envelope.value);
      return;
    }
    this.#failProtocol(new Error(`fake provider ${envelope.code}`));
  }

  #failProtocol(error: Error): void {
    for (const invocation of this.#invocations.values()) invocation.fail(error);
    this.#invocations.clear();
    for (const waiter of this.#pullWaiters.values()) waiter.reject(error);
    this.#pullWaiters.clear();
    for (const waiter of this.#cancelWaiters.values()) waiter.reject(error);
    this.#cancelWaiters.clear();
    this.#child.kill();
  }
}

export function startScriptedFakeProvider(t: TestContext): ScriptedFakeProvider {
  const fixture = createScriptedFakeProvider();
  t.after(async () => fixture.close());
  return fixture;
}

/** Creates a fixture whose lifecycle is owned by a test-only child process. */
export function createScriptedFakeProvider(): ScriptedFakeProvider {
  return new ProviderFixture();
}
