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
  mode: "version" | "app-server" | "invalid";
  arguments: string[];
  cwd: string;
  environment: Record<string, string>;
  requests: Readonly<Record<string, unknown>>[];
  stdinClosed: boolean;
  descendantPid: number | undefined;
  socket: Socket;
}

interface HelloMessage {
  readonly channel: "hello";
  readonly mode: "version" | "app-server" | "invalid";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
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
  waitForLaunches(count: number): Promise<void>;
  waitForRequests(count: number): Promise<void>;
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
    mode: record.mode,
    arguments: [...record.arguments],
    cwd: record.cwd,
    environment: { ...record.environment },
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

async function cleanRecordedDescendant(pid: number): Promise<void> {
  if (!signalRecordedDescendant(pid, "SIGTERM")) return;
  const deadline = Date.now() + CLEANUP_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  signalRecordedDescendant(pid, "SIGKILL");
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
        const plan = plans.shift();
        if (plan === undefined || plan.kind !== message.mode) {
          fixtureErrors.push("fake process did not match the queued plan");
          socket.destroy();
          return;
        }
        record = {
          mode: message.mode,
          arguments: [...message.arguments],
          cwd: message.cwd,
          environment: { ...message.environment },
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
      await cleanRecordedDescendant(pid);
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
    async readConfigSentinel() {
      return await readFile(configSentinelPath);
    },
    spawnForFixture(arguments_, options) {
      const child = spawn(executablePath, [...arguments_], {
        cwd: options.cwd,
        env: { ...options.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
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
