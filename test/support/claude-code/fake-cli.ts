import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { FakeClaudeLaunchRecord, FakeClaudeProcessPlan } from "./types.js";

interface MutableLaunchRecord {
  executable: string;
  mode: "version" | "turn";
  arguments: string[];
  cwd: string;
  environment: Record<string, string>;
  pid: number;
  stdinRecords: string[];
  stdinChunks: Buffer[];
  stdinClosed: boolean;
  signals: NodeJS.Signals[];
  descendantPid: number | undefined;
  barriers: string[];
  socket: Socket;
}

type WorkerMessage =
  | {
      readonly channel: "hello";
      readonly executable: string;
      readonly mode: "version" | "turn";
      readonly arguments: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly pid: number;
    }
  | { readonly channel: "stdin"; readonly raw: string }
  | { readonly channel: "stdin_bytes"; readonly value: string }
  | { readonly channel: "stdin_closed" }
  | { readonly channel: "signal"; readonly signal: NodeJS.Signals }
  | { readonly channel: "descendant"; readonly pid?: number }
  | { readonly channel: "barrier"; readonly name: string }
  | { readonly channel: "fixture_error"; readonly code: string };

export interface FakeClaudeCli {
  readonly executablePath: string;
  readonly launches: readonly FakeClaudeLaunchRecord[];
  enqueue(plan: FakeClaudeProcessPlan): void;
  release(gate: string): void;
  waitForLaunches(count: number): Promise<void>;
  waitForInputRecords(count: number): Promise<void>;
  waitForStdinClosed(count: number): Promise<void>;
  waitForSignals(count: number): Promise<void>;
  waitForBarrier(name: string): Promise<void>;
  quiesce(): Promise<void>;
  spawnForFixture(
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly detached?: boolean;
    },
  ): ChildProcess;
}

const WAIT_MS = 5_000;
const CLEANUP_MS = 2_000;

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`fake Claude ${description} did not occur`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function terminate(pid: number | undefined): Promise<void> {
  if (pid === undefined || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + CLEANUP_MS;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function immutable(record: MutableLaunchRecord): FakeClaudeLaunchRecord {
  return {
    executable: record.executable,
    mode: record.mode,
    arguments: [...record.arguments],
    cwd: record.cwd,
    environment: { ...record.environment },
    pid: record.pid,
    stdinRecords: [...record.stdinRecords],
    stdinBase64: Buffer.concat(record.stdinChunks).toString("base64"),
    stdinClosed: record.stdinClosed,
    signals: [...record.signals],
    descendantPid: record.descendantPid,
    barriers: [...record.barriers],
  };
}

export async function startFakeClaudeCli(
  t: TestContext,
  initialPlans: readonly FakeClaudeProcessPlan[] = [],
): Promise<FakeClaudeCli> {
  assert.notEqual(process.platform, "win32", "ADR 0033 defers Windows connector support");
  const root = await mkdtemp(join(tmpdir(), "a2a-cl02-claude-"));
  const fixturePath = join(root, "claude");
  const compiledWorker = fileURLToPath(new URL("./fake-claude-cli.js", import.meta.url));
  await copyFile(compiledWorker, fixturePath);
  await chmod(fixturePath, 0o700);
  const executablePath = await realpath(fixturePath);
  const controlSocketPath = `${executablePath}.control.sock`;

  const plans = [...initialPlans];
  const records: MutableLaunchRecord[] = [];
  const fixtureErrors: string[] = [];
  const sockets = new Set<Socket>();
  const fixtureChildren = new Set<ChildProcess>();
  let quiesced = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const handleControlError = (error: NodeJS.ErrnoException): void => {
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
        fixtureErrors.push("fake CLI control socket failed");
      }
    };
    socket.on("error", handleControlError);
    let record: MutableLaunchRecord | undefined;
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("error", handleControlError);
    lines.on("line", (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        fixtureErrors.push("fake CLI control emitted malformed JSON");
        socket.destroy();
        return;
      }
      if (message.channel === "hello") {
        if (record !== undefined) {
          fixtureErrors.push("fake CLI repeated hello");
          socket.destroy();
          return;
        }
        const plan = plans.shift();
        if (plan === undefined || plan.kind !== message.mode) {
          fixtureErrors.push("fake CLI launch did not match its queued plan");
          socket.destroy();
          return;
        }
        record = {
          executable: message.executable,
          mode: message.mode,
          arguments: [...message.arguments],
          cwd: message.cwd,
          environment: { ...message.environment },
          pid: message.pid,
          stdinRecords: [],
          stdinChunks: [],
          stdinClosed: false,
          signals: [],
          descendantPid: undefined,
          barriers: [],
          socket,
        };
        records.push(record);
        socket.write(`${JSON.stringify({ command: "plan", plan })}\n`);
        return;
      }
      if (record === undefined) {
        fixtureErrors.push("fake CLI emitted control before hello");
        socket.destroy();
        return;
      }
      if (message.channel === "stdin") record.stdinRecords.push(message.raw);
      else if (message.channel === "stdin_bytes") {
        record.stdinChunks.push(Buffer.from(message.value, "base64"));
      } else if (message.channel === "stdin_closed") record.stdinClosed = true;
      else if (message.channel === "signal") {
        record.signals.push(message.signal);
        socket.write(`${JSON.stringify({ command: "signal_ack", signal: message.signal })}\n`);
      } else if (message.channel === "descendant") record.descendantPid = message.pid;
      else if (message.channel === "barrier") record.barriers.push(message.name);
      else if (message.channel === "fixture_error") fixtureErrors.push(message.code);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const quiesce = async (): Promise<void> => {
    if (quiesced) return;
    quiesced = true;
    for (const child of fixtureChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const record of records) {
      await terminate(record.descendantPid);
      await terminate(record.pid);
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  t.after(async () => {
    await quiesce();
    await rm(root, { recursive: true, force: true });
  });

  return {
    executablePath,
    get launches() {
      assert.deepEqual(fixtureErrors, []);
      return records.map(immutable);
    },
    enqueue(plan) {
      plans.push(plan);
    },
    release(gate) {
      const active = records.at(-1);
      assert.ok(active !== undefined, "no fake Claude process is active");
      active.socket.write(`${JSON.stringify({ command: "release", gate })}\n`);
    },
    async waitForLaunches(count) {
      await waitFor(() => records.length >= count, "launch");
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForInputRecords(count) {
      await waitFor(
        () => records.reduce((sum, entry) => sum + entry.stdinRecords.length, 0) >= count,
        "stdin record",
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForStdinClosed(count) {
      await waitFor(
        () => records.filter((entry) => entry.stdinClosed).length >= count,
        "stdin EOF",
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForSignals(count) {
      await waitFor(
        () => records.reduce((sum, entry) => sum + entry.signals.length, 0) >= count,
        "signal",
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForBarrier(name) {
      await waitFor(
        () => records.some((entry) => entry.barriers.includes(name)),
        `barrier ${name}`,
      );
      assert.deepEqual(fixtureErrors, []);
    },
    quiesce,
    spawnForFixture(arguments_, options) {
      const child = spawn(executablePath, [...arguments_], {
        cwd: options.cwd,
        env: { ...options.env },
        detached: options.detached ?? false,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      fixtureChildren.add(child);
      child.once("close", () => fixtureChildren.delete(child));
      return child;
    },
  };
}
