import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";

import { ProcessLock } from "../src/process-lock.js";

const WORKER_SOURCE = `
const lockPath = process.env.A2A_TEST_LOCK_PATH;
const moduleUrl = process.env.A2A_TEST_LOCK_MODULE_URL;
if (lockPath === undefined || moduleUrl === undefined) throw new Error("missing worker environment");
const { ProcessLock } = await import(moduleUrl);
process.send({ type: "ready" });
process.once("message", async (command) => {
  if (command !== "acquire") throw new Error("unexpected worker command");
  try {
    const lock = await ProcessLock.acquire(lockPath);
    const releaseCommand = new Promise((resolve) => process.once("message", resolve));
    process.send({ type: "acquired" });
    if ((await releaseCommand) !== "release") throw new Error("unexpected owner command");
    await lock.release();
    process.send({ type: "released" });
  } catch (error) {
    process.send({
      type: "rejected",
      code: error !== null && typeof error === "object" && "code" in error ? error.code : null,
    });
  } finally {
    process.disconnect();
  }
});
`;

interface LockWorker {
  child: ChildProcess;
  stderr: () => string;
}

interface WorkerMessage {
  type: "ready" | "acquired" | "rejected" | "released";
  code?: unknown;
}

async function lockPath(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-lock-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return join(directory, "daemon.lock");
}

function nextMessage(worker: LockWorker): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as WorkerMessage);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Lock worker exited before responding (code=${String(code)}, signal=${String(signal)}): ${worker.stderr()}`,
        ),
      );
    };
    const cleanup = () => {
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
    };
    worker.child.once("message", onMessage);
    worker.child.once("exit", onExit);
  });
}

async function startWorker(t: TestContext, path: string): Promise<LockWorker> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER_SOURCE], {
    env: {
      ...process.env,
      A2A_TEST_LOCK_MODULE_URL: new URL("../src/process-lock.js", import.meta.url).href,
      A2A_TEST_LOCK_PATH: path,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const worker = { child, stderr: () => stderr };
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  assert.deepEqual(await nextMessage(worker), { type: "ready" });
  return worker;
}

test("allows one owner and can be reacquired while retaining its artifact", async (t) => {
  const path = await lockPath(t);
  const first = await ProcessLock.acquire(path);

  await assert.rejects(ProcessLock.acquire(path), { code: "daemon_running" });
  const contender = await startWorker(t, path);
  const contenderOutcome = nextMessage(contender);
  contender.child.send("acquire");
  assert.deepEqual(await contenderOutcome, { type: "rejected", code: "daemon_running" });
  await first.release();
  await first.release();
  await access(path);

  const second = await ProcessLock.acquire(path);
  await second.release();
  await access(path);
});

test("filesystem aliases cannot invalidate a same-process owner", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-lock-alias-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const realRoot = join(root, "real");
  const aliasRoot = join(root, "alias");
  const lockDirectory = join(realRoot, "locks");
  await mkdir(lockDirectory, { recursive: true });
  await symlink(realRoot, aliasRoot);
  const path = join(lockDirectory, "daemon.lock");
  const aliasPath = join(aliasRoot, "locks", "daemon.lock");
  const owner = await ProcessLock.acquire(path);
  t.after(() => owner.release());

  await assert.rejects(ProcessLock.acquire(aliasPath), { code: "daemon_running" });
  const contender = await startWorker(t, path);
  const contenderOutcome = nextMessage(contender);
  contender.child.send("acquire");
  assert.deepEqual(await contenderOutcome, { type: "rejected", code: "daemon_running" });

  await owner.release();
});

test("atomically selects one contender after its previous owner crashes", async (t) => {
  const path = await lockPath(t);
  const crashedOwner = await startWorker(t, path);
  const ownerOutcome = nextMessage(crashedOwner);
  crashedOwner.child.send("acquire");
  assert.deepEqual(await ownerOutcome, { type: "acquired" });
  await access(path);

  const ownerExit = once(crashedOwner.child, "exit");
  assert.equal(crashedOwner.child.kill("SIGKILL"), true);
  await ownerExit;
  await access(path);

  const contenders = await Promise.all(Array.from({ length: 8 }, () => startWorker(t, path)));
  const outcomes = contenders.map((worker) => nextMessage(worker));
  for (const contender of contenders) contender.child.send("acquire");
  const settledOutcomes = await Promise.all(outcomes);

  const ownerIndexes = settledOutcomes.flatMap((outcome, index) =>
    outcome.type === "acquired" ? [index] : [],
  );
  assert.equal(ownerIndexes.length, 1);
  for (const outcome of settledOutcomes) {
    if (outcome.type !== "acquired") {
      assert.deepEqual(outcome, { type: "rejected", code: "daemon_running" });
    }
  }

  const winner = contenders[ownerIndexes[0] as number];
  assert.ok(winner !== undefined);
  const released = nextMessage(winner);
  winner.child.send("release");
  assert.deepEqual(await released, { type: "released" });

  const reacquired = await ProcessLock.acquire(path);
  await reacquired.release();
});

test("rejects an invalid lock artifact without replacing it", async (t) => {
  const path = await lockPath(t);
  await writeFile(path, "not a sqlite database\n", { mode: 0o600 });

  await assert.rejects(ProcessLock.acquire(path), { code: "lock_invalid" });
  assert.equal(await readFile(path, "utf8"), "not a sqlite database\n");
});

test("rejects a hard-linked lock artifact without changing its target", async (t) => {
  const path = await lockPath(t);
  const targetPath = join(dirname(path), "target.sqlite");
  await writeFile(targetPath, "", { mode: 0o644 });
  await link(targetPath, path);

  await assert.rejects(ProcessLock.acquire(path), { code: "lock_invalid" });

  assert.equal((await stat(targetPath)).size, 0);
  if (process.platform !== "win32") {
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  }
});

test("enforces owner-only artifact and directory permissions on POSIX", {
  skip: process.platform === "win32",
}, async (t) => {
  const path = await lockPath(t);
  await chmod(dirname(path), 0o777);

  const lock = await ProcessLock.acquire(path);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await lock.release();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
