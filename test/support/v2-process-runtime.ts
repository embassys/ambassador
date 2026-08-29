import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TestContext } from "node:test";

import { V2ProcessBarrierController } from "./v2-process-barriers.js";

export interface V2ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface V2ManagedProcess {
  readonly child: ChildProcess;
  readonly barriers: V2ProcessBarrierController;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutTruncated: () => boolean;
  readonly stderrTruncated: () => boolean;
  readonly waitForOutput: (
    stream: "stdout" | "stderr",
    expected: string | RegExp,
    timeoutMs?: number,
  ) => Promise<void>;
  readonly waitForExit: () => Promise<V2ProcessExit>;
  readonly stop: () => Promise<V2ProcessExit>;
}

interface OutputWaiter {
  readonly expected: string | RegExp;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class BoundedOutput {
  readonly #decoder = new StringDecoder("utf8");
  readonly #limit: number;
  readonly #waiters = new Set<OutputWaiter>();
  #text = "";
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    this.#appendText(this.#decoder.write(chunk));
  }

  finish(): void {
    this.#appendText(this.#decoder.end());
  }

  #appendText(text: string): void {
    this.#text += text;
    const bytes = Buffer.from(this.#text, "utf8");
    if (bytes.byteLength > this.#limit) {
      let start = bytes.byteLength - this.#limit;
      while (start < bytes.byteLength && (bytes[start] ?? 0) >> 6 === 0b10) start += 1;
      this.#text = bytes.subarray(start).toString("utf8");
      this.#truncated = true;
    }
    for (const waiter of this.#waiters) {
      if (!matches(this.#text, waiter.expected)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  value(): string {
    return this.#text;
  }

  truncated(): boolean {
    return this.#truncated;
  }

  async waitFor(expected: string | RegExp, timeoutMs: number): Promise<void> {
    if (matches(this.#text, expected)) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: OutputWaiter = {
        expected,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("timed out waiting for child-process readiness output"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.#waiters.add(waiter);
    });
  }

  failWaiters(): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("child process exited before readiness"));
    }
    this.#waiters.clear();
  }
}

function matches(value: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return value.includes(expected);
  expected.lastIndex = 0;
  return expected.test(value);
}

function validateBound(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`invalid ${name}`);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([
    operation.then((value) => ({ timedOut: false as const, value })),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function managedPid(child: ChildProcess): number | undefined {
  const pid = child.pid;
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function signalPosixProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function posixProcessGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // A null signal can return EPERM for an existing group that currently has
    // no signalable member, including while macOS is reaping a killed child.
    // Keep waiting so a persistent inaccessible descendant fails the bound.
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(groupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }
  return true;
}

async function stopPosixProcessGroup(
  groupId: number,
  gracefulStopMs: number,
  forcedStopMs: number,
): Promise<void> {
  if (!signalPosixProcessGroup(groupId, "SIGTERM")) return;
  if (await waitForPosixProcessGroupExit(groupId, gracefulStopMs)) return;
  signalPosixProcessGroup(groupId, "SIGKILL");
  if (!(await waitForPosixProcessGroupExit(groupId, forcedStopMs))) {
    throw new Error("managed process group did not stop within its bound");
  }
}

async function forceStopWindowsTree(pid: number, timeoutMs: number): Promise<void> {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const completion = new Promise<void>((resolve) => {
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
  const result = await withTimeout(completion, timeoutMs);
  if (result.timedOut && killer.exitCode === null && killer.signalCode === null) {
    killer.kill("SIGKILL");
  }
}

/**
 * Spawns one isolated process group with bounded output and teardown. Callers
 * provide an explicit environment rather than inheriting the test runner's.
 */
export function startV2ManagedProcess(
  t: TestContext,
  options: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly outputLimitBytes?: number;
    readonly gracefulStopMs?: number;
    readonly forcedStopMs?: number;
  },
): V2ManagedProcess {
  const outputLimit = options.outputLimitBytes ?? 65_536;
  const gracefulStopMs = options.gracefulStopMs ?? 1_000;
  const forcedStopMs = options.forcedStopMs ?? 1_000;
  validateBound(outputLimit, "child-process output limit", 4 * 1_024 * 1_024);
  validateBound(gracefulStopMs, "graceful child-process stop timeout", 30_000);
  validateBound(forcedStopMs, "forced child-process stop timeout", 30_000);

  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const processId = managedPid(child);
  const stdout = new BoundedOutput(outputLimit);
  const stderr = new BoundedOutput(outputLimit);
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let exitState: V2ProcessExit | undefined;
  let spawnError: Error | undefined;
  const completion = new Promise<V2ProcessExit>((resolve, reject) => {
    child.once("error", (error) => {
      spawnError = error;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exitState = { code, signal };
    });
    child.once("close", () => {
      stdout.finish();
      stderr.finish();
      stdout.failWaiters();
      stderr.failWaiters();
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      if (exitState === undefined) {
        reject(new Error("managed process closed without an exit state"));
        return;
      }
      resolve(exitState);
    });
  });
  const barriers = new V2ProcessBarrierController(child);
  let stopPromise: Promise<V2ProcessExit> | undefined;
  const stop = async (): Promise<V2ProcessExit> => {
    stopPromise ??= (async () => {
      if (process.platform !== "win32" && processId !== undefined) {
        await stopPosixProcessGroup(processId, gracefulStopMs, forcedStopMs);
        const drained = await withTimeout(completion, forcedStopMs);
        if (drained.timedOut) {
          throw new Error("managed process output did not close within its bound");
        }
        return drained.value;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        const drained = await withTimeout(completion, forcedStopMs);
        if (drained.timedOut) {
          throw new Error("managed process output did not close within its bound");
        }
        return drained.value;
      }
      child.kill("SIGTERM");
      const graceful = await withTimeout(completion, gracefulStopMs);
      if (!graceful.timedOut) return graceful.value;
      if (process.platform === "win32" && processId !== undefined) {
        await forceStopWindowsTree(processId, forcedStopMs);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      const forced = await withTimeout(completion, forcedStopMs);
      if (forced.timedOut) throw new Error("managed process did not stop within its bound");
      return forced.value;
    })();
    return await stopPromise;
  };
  t.after(async () => {
    try {
      await stop();
    } finally {
      barriers.close();
    }
  });

  return {
    child,
    barriers,
    stdout: () => stdout.value(),
    stderr: () => stderr.value(),
    stdoutTruncated: () => stdout.truncated(),
    stderrTruncated: () => stderr.truncated(),
    waitForOutput: async (stream, expected, timeoutMs = 5_000) => {
      validateBound(timeoutMs, "child-process readiness timeout", 60_000);
      await (stream === "stdout" ? stdout : stderr).waitFor(expected, timeoutMs);
    },
    waitForExit: async () => await completion,
    stop,
  };
}

/** Minimal platform values needed when an absolute Node executable is used. */
export function v2NodeProcessEnvironment(
  additions: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    ...additions,
  };
}
