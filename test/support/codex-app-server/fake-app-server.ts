import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { FakeCodexLaunchRecord, FakeCodexProcessPlan } from "./types.js";

interface MutableLaunchRecord {
  executable: string;
  mode: "version" | "app-server" | "invalid";
  arguments: string[];
  cwd: string;
  environment: Record<string, string>;
  shell: false;
  pid: number;
  containmentForTest: "kill" | "fail";
  requests: Readonly<Record<string, unknown>>[];
  stdinClosed: boolean;
  descendantPid: number | undefined;
  socket: Socket;
}

interface HelloMessage {
  readonly channel: "hello";
  readonly executable: string;
  readonly mode: "version" | "app-server" | "invalid";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly pid: number;
}

type WorkerMessage =
  | HelloMessage
  | { readonly channel: "request"; readonly raw: string; readonly value: unknown }
  | { readonly channel: "stdin_closed" }
  | { readonly channel: "descendant"; readonly pid?: number }
  | { readonly channel: "fixture_error"; readonly code: string };

export interface FakeCodexAppServer {
  readonly executablePath: string;
  readonly controlSocketPath: string;
  readonly configSentinelPath: string;
  readonly launches: readonly FakeCodexLaunchRecord[];
  enqueue(plan: FakeCodexProcessPlan): void;
  release(gate: string): void;
  releaseAll(gate: string): void;
  waitForLaunches(count: number): Promise<void>;
  waitForRequests(count: number): Promise<void>;
  waitForStdinClosed(count: number): Promise<void>;
  waitForDescendants(count: number): Promise<void>;
  containLatestUnit(): Promise<boolean>;
  isLatestUnitEmpty(): boolean;
  readConfigSentinel(): Promise<Buffer>;
  spawnForFixture(
    arguments_: readonly string[],
    options: { cwd: string; environment: Readonly<Record<string, string>> },
  ): ChildProcessWithoutNullStreams;
}

const WAIT_MS = 5_000;
const CLEANUP_MS = 2_000;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fake Codex observation did not occur");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function immutable(record: MutableLaunchRecord): FakeCodexLaunchRecord {
  return {
    executable: record.executable,
    mode: record.mode,
    arguments: [...record.arguments],
    cwd: record.cwd,
    environment: { ...record.environment },
    shell: record.shell,
    pid: record.pid,
    requests: record.requests.map((request) => structuredClone(request)),
    stdinClosed: record.stdinClosed,
    descendantPid: record.descendantPid,
  };
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  completion: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await completion;
    return;
  }
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    completion.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), CLEANUP_MS)),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([
    completion,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("fake Codex child did not exit")), CLEANUP_MS),
    ),
  ]);
}

function signalRecordedDescendant(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
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

function unitIsEmpty(record: MutableLaunchRecord): boolean {
  return !processExists(record.pid) && !processExists(record.descendantPid);
}

async function waitForUnitEmpty(record: MutableLaunchRecord): Promise<boolean> {
  const deadline = Date.now() + CLEANUP_MS;
  while (!unitIsEmpty(record)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function waitForRecordedProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + CLEANUP_MS;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return !processExists(pid);
}

async function terminateRecordedProcess(pid: number): Promise<void> {
  if (!signalRecordedDescendant(pid, "SIGTERM")) return;
  if (await waitForRecordedProcessExit(pid)) return;
  if (!signalRecordedDescendant(pid, "SIGKILL")) return;
  assert.equal(
    await waitForRecordedProcessExit(pid),
    true,
    `fake Codex process ${pid} survived SIGKILL`,
  );
}

export async function startFakeCodexAppServer(
  t: TestContext,
  initialPlans: readonly FakeCodexProcessPlan[] = [],
): Promise<FakeCodexAppServer> {
  assert.notEqual(process.platform, "win32", "ADR 0033 defers Windows connector support");
  const root = await mkdtemp(join(tmpdir(), "a2a-cx02-codex-"));
  const executablePath = join(root, "codex");
  const controlSocketPath = `${executablePath}.control.sock`;
  const configSentinelPath = join(root, "provider-config-sentinel");
  const compiledWorker = fileURLToPath(new URL("./fake-codex-app-server.js", import.meta.url));
  await copyFile(compiledWorker, executablePath);
  await chmod(executablePath, 0o700);
  await writeFile(configSentinelPath, "CX02 provider config must stay byte-identical\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const plans = [...initialPlans];
  const injectedPlans = new Map<number, FakeCodexProcessPlan | undefined>();
  const records: MutableLaunchRecord[] = [];
  const fixtureErrors: string[] = [];
  const sockets = new Set<Socket>();
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let record: MutableLaunchRecord | undefined;
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        fixtureErrors.push("fake control channel emitted malformed JSON");
        socket.destroy();
        return;
      }
      if (message.channel === "hello") {
        if (record !== undefined) {
          fixtureErrors.push("fake process repeated its hello");
          socket.destroy();
          return;
        }
        const injected = injectedPlans.has(message.pid);
        const plan = injected ? injectedPlans.get(message.pid) : plans.shift();
        if (injected) injectedPlans.delete(message.pid);
        if (plan === undefined || plan.kind !== message.mode) {
          fixtureErrors.push("fake process did not match the queued plan");
          socket.destroy();
          return;
        }
        record = {
          executable: message.executable,
          mode: message.mode,
          arguments: [...message.arguments],
          cwd: message.cwd,
          environment: { ...message.environment },
          shell: message.shell,
          pid: message.pid,
          containmentForTest:
            plan.kind === "app-server" ? (plan.containmentForTest ?? "kill") : "kill",
          requests: [],
          stdinClosed: false,
          descendantPid: undefined,
          socket,
        };
        records.push(record);
        socket.write(`${JSON.stringify({ command: "plan", plan })}\n`);
        return;
      }
      if (record === undefined) {
        fixtureErrors.push("fake process emitted data before hello");
        socket.destroy();
        return;
      }
      if (message.channel === "request") {
        if (
          message.value === null ||
          typeof message.value !== "object" ||
          Array.isArray(message.value)
        ) {
          fixtureErrors.push("fake process observed a non-object request");
          return;
        }
        record.requests.push(structuredClone(message.value as Readonly<Record<string, unknown>>));
      } else if (message.channel === "stdin_closed") {
        record.stdinClosed = true;
      } else if (message.channel === "descendant") {
        record.descendantPid = message.pid;
      } else if (message.channel === "fixture_error") {
        fixtureErrors.push(message.code);
      }
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
    for (const [child, completion] of children) await waitForChildExit(child, completion);
    for (const pid of new Set(records.flatMap((record) => record.descendantPid ?? []))) {
      await terminateRecordedProcess(pid);
    }
    for (const pid of new Set(records.map((record) => record.pid))) {
      await terminateRecordedProcess(pid);
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  return {
    executablePath,
    controlSocketPath,
    configSentinelPath,
    get launches() {
      assert.deepEqual(fixtureErrors, []);
      return records.map(immutable);
    },
    enqueue(plan) {
      plans.push(plan);
    },
    release(gate) {
      const active = records.at(-1);
      assert.ok(active !== undefined, "no fake Codex process is active");
      active.socket.write(`${JSON.stringify({ command: "release", gate })}\n`);
    },
    releaseAll(gate) {
      const active = records.filter(
        (record) => record.mode === "app-server" && !record.stdinClosed && record.socket.writable,
      );
      assert.ok(active.length > 0, "no fake Codex process is active");
      for (const record of active) {
        record.socket.write(`${JSON.stringify({ command: "release", gate })}\n`);
      }
    },
    async waitForLaunches(count) {
      await waitFor(() => records.length >= count || fixtureErrors.length > 0);
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForRequests(count) {
      await waitFor(
        () =>
          records.reduce((total, current) => total + current.requests.length, 0) >= count ||
          fixtureErrors.length > 0,
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForStdinClosed(count) {
      await waitFor(
        () =>
          records.filter((record) => record.stdinClosed).length >= count ||
          fixtureErrors.length > 0,
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async waitForDescendants(count) {
      await waitFor(
        () =>
          records.filter((record) => record.descendantPid !== undefined).length >= count ||
          fixtureErrors.length > 0,
      );
      assert.deepEqual(fixtureErrors, []);
    },
    async containLatestUnit() {
      const record = records.findLast((candidate) => candidate.mode === "app-server");
      assert.ok(record !== undefined, "no fake Codex App Server unit exists");
      if (record.containmentForTest === "fail") return false;
      if (processExists(record.descendantPid)) {
        assert.ok(record.descendantPid !== undefined);
        signalRecordedDescendant(record.descendantPid, "SIGTERM");
      }
      if (processExists(record.pid)) signalRecordedDescendant(record.pid, "SIGTERM");
      if (await waitForUnitEmpty(record)) return true;
      if (processExists(record.descendantPid)) {
        assert.ok(record.descendantPid !== undefined);
        signalRecordedDescendant(record.descendantPid, "SIGKILL");
      }
      if (processExists(record.pid)) signalRecordedDescendant(record.pid, "SIGKILL");
      return await waitForUnitEmpty(record);
    },
    isLatestUnitEmpty() {
      const record = records.at(-1);
      return record === undefined || unitIsEmpty(record);
    },
    async readConfigSentinel() {
      return await readFile(configSentinelPath);
    },
    spawnForFixture(arguments_, options) {
      const plan = plans.shift();
      const child = spawn(executablePath, [...arguments_], {
        cwd: options.cwd,
        env: { ...options.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (child.pid === undefined || child.pid <= 0) {
        fixtureErrors.push("fake process did not return a positive pid");
      } else {
        injectedPlans.set(child.pid, plan);
      }
      const completion = new Promise<void>((resolve) => {
        child.once("error", () => resolve());
        child.once("close", () => resolve());
      });
      children.set(child, completion);
      void completion.then(() => children.delete(child));
      return child;
    },
  };
}
