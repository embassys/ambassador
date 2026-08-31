import assert from "node:assert/strict";
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FakeClaudeWireWrite, FakeMonitorLaunchRecord, FakeMonitorPlan } from "./types.js";

export interface ClaudeMonitorSpawnOptionsForTest {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"];
}

interface MutableMonitorRecord {
  requestedExecutable: string;
  requestedArguments: string[];
  requestedCwd: string;
  requestedEnvironment: Record<string, string>;
  requestedDetached: true;
  requestedShell: false;
  requestedStdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"];
  pid: number;
  commands: unknown[];
  ownerClosed: boolean;
  barriers: string[];
  signals: NodeJS.Signals[];
  seals: string[];
  socket: Socket;
}

type WorkerMessage =
  | { readonly channel: "hello"; readonly pid: number; readonly cwd: string }
  | { readonly channel: "command"; readonly value: unknown }
  | { readonly channel: "owner_closed" }
  | { readonly channel: "signal"; readonly signal: NodeJS.Signals }
  | { readonly channel: "seal"; readonly reason: string }
  | { readonly channel: "barrier"; readonly name: string }
  | { readonly channel: "fixture_error"; readonly code: string };

export interface FakeClaudeMonitor {
  readonly modulePath: string;
  readonly launches: readonly FakeMonitorLaunchRecord[];
  enqueue(plan: FakeMonitorPlan): void;
  release(gate: string): void;
  emitLifecycle(write: FakeClaudeWireWrite): void;
  registerExternalLaunch(
    executable: string,
    arguments_: readonly string[],
    options: ClaudeMonitorSpawnOptionsForTest,
  ): void;
  waitForLaunches(count: number): Promise<void>;
  waitForCommands(count: number): Promise<void>;
  waitForOwnerClosed(count: number): Promise<void>;
  waitForBarrier(name: string): Promise<void>;
  spawnForAdapter(
    executable: string,
    arguments_: readonly string[],
    options: ClaudeMonitorSpawnOptionsForTest,
  ): ChildProcess;
}

const WAIT_MS = 5_000;
const CLEANUP_MS = 2_000;

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`fake monitor ${description} did not occur`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function terminateGroup(pgid: number): Promise<void> {
  if (!groupExists(pgid)) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + CLEANUP_MS;
  while (groupExists(pgid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!groupExists(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function immutable(record: MutableMonitorRecord): FakeMonitorLaunchRecord {
  return {
    requestedExecutable: record.requestedExecutable,
    requestedArguments: [...record.requestedArguments],
    requestedCwd: record.requestedCwd,
    requestedEnvironment: { ...record.requestedEnvironment },
    requestedDetached: record.requestedDetached,
    requestedShell: record.requestedShell,
    requestedStdio: [...record.requestedStdio],
    pid: record.pid,
    commands: structuredClone(record.commands),
    ownerClosed: record.ownerClosed,
    barriers: [...record.barriers],
    signals: [...record.signals],
    seals: [...record.seals],
  };
}

export async function startFakeClaudeMonitor(
  t: TestContext,
  initialPlans: readonly FakeMonitorPlan[] = [],
): Promise<FakeClaudeMonitor> {
  assert.notEqual(process.platform, "win32", "ADR 0033 defers Windows connector support");
  const root = await mkdtemp(join(tmpdir(), "a2a-cl02-monitor-"));
  const modulePath = join(root, "m.mjs");
  const controlSocketPath = `${modulePath}.control.sock`;
  const compiledWorker = fileURLToPath(new URL("./fake-lifetime-monitor.js", import.meta.url));
  await copyFile(compiledWorker, modulePath);
  await chmod(modulePath, 0o700);

  const plans = [...initialPlans];
  const pendingLaunches: Omit<
    MutableMonitorRecord,
    "pid" | "commands" | "ownerClosed" | "barriers" | "signals" | "seals" | "socket"
  >[] = [];
  const records: MutableMonitorRecord[] = [];
  const fixtureErrors: string[] = [];
  const sockets = new Set<Socket>();
  const children = new Set<ChildProcess>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let record: MutableMonitorRecord | undefined;
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        fixtureErrors.push("fake monitor control emitted malformed JSON");
        socket.destroy();
        return;
      }
      if (message.channel === "hello") {
        const pending = pendingLaunches.shift();
        const plan = plans.shift();
        if (record !== undefined || pending === undefined || plan === undefined) {
          fixtureErrors.push("fake monitor launch did not match its queued plan");
          socket.destroy();
          return;
        }
        record = {
          ...pending,
          pid: message.pid,
          commands: [],
          ownerClosed: false,
          barriers: [],
          signals: [],
          seals: [],
          socket,
        };
        records.push(record);
        socket.write(`${JSON.stringify({ command: "plan", plan })}\n`);
        return;
      }
      if (record === undefined) {
        fixtureErrors.push("fake monitor emitted control before hello");
        socket.destroy();
        return;
      }
      if (message.channel === "command") record.commands.push(structuredClone(message.value));
      else if (message.channel === "owner_closed") record.ownerClosed = true;
      else if (message.channel === "barrier") record.barriers.push(message.name);
      else if (message.channel === "signal") record.signals.push(message.signal);
      else if (message.channel === "seal") record.seals.push(message.reason);
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

  t.after(async () => {
    for (const record of records) await terminateGroup(record.pid);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const spawnForAdapter = (
    executable: string,
    arguments_: readonly string[],
    options: ClaudeMonitorSpawnOptionsForTest,
  ): ChildProcess => {
    registerExternalLaunch(executable, arguments_, options);
    const actualOptions: SpawnOptions = {
      cwd: options.cwd,
      env: { ...options.env },
      detached: options.detached,
      shell: options.shell,
      stdio: [...options.stdio],
    };
    const child = spawn(process.execPath, [modulePath], actualOptions);
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };

  const registerExternalLaunch = (
    executable: string,
    arguments_: readonly string[],
    options: ClaudeMonitorSpawnOptionsForTest,
  ): void => {
    pendingLaunches.push({
      requestedExecutable: executable,
      requestedArguments: [...arguments_],
      requestedCwd: options.cwd,
      requestedEnvironment: { ...options.env },
      requestedDetached: options.detached,
      requestedShell: options.shell,
      requestedStdio: [...options.stdio],
    });
  };

  return {
    modulePath,
    get launches() {
      assert.deepEqual(fixtureErrors, []);
      return records.map(immutable);
    },
    enqueue(plan) {
      plans.push(plan);
    },
    release(gate) {
      const active = records.at(-1);
      assert.ok(active !== undefined, "no fake monitor is active");
      active.socket.write(`${JSON.stringify({ command: "release", gate })}\n`);
    },
    emitLifecycle(write) {
      const active = records.at(-1);
      assert.ok(active !== undefined, "no fake monitor is active");
      active.socket.write(`${JSON.stringify({ command: "emit", write })}\n`);
    },
    registerExternalLaunch,
    async waitForLaunches(count) {
      await waitFor(() => records.length >= count, "launch");
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForCommands(count) {
      await waitFor(
        () => records.reduce((sum, entry) => sum + entry.commands.length, 0) >= count,
        "command",
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForOwnerClosed(count) {
      await waitFor(
        () => records.filter((entry) => entry.ownerClosed).length >= count,
        "owner EOF",
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
    spawnForAdapter,
  };
}
