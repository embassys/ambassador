import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { ProcessLock } from "../src/process-lock.js";

async function lockPath(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-lock-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return join(directory, "daemon.lock");
}

test("allows one owner and can be reacquired after release", async (t) => {
  const path = await lockPath(t);
  const options = { pid: 42, token: "owner-one", isProcessAlive: () => true };
  const first = await ProcessLock.acquire(path, options);

  await assert.rejects(ProcessLock.acquire(path, { ...options, token: "owner-two" }));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pid: 42, token: "owner-one" });

  await first.release();
  const second = await ProcessLock.acquire(path, { ...options, token: "owner-two" });
  await second.release();
});

test("replaces a well-formed stale lock but not an invalid lock file", async (t) => {
  const path = await lockPath(t);
  await writeFile(path, '{"pid":99,"token":"stale"}\n', { mode: 0o600 });

  const lock = await ProcessLock.acquire(path, {
    pid: 42,
    token: "replacement",
    isProcessAlive: (pid) => pid !== 99,
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    pid: 42,
    token: "replacement",
  });
  await lock.release();

  await writeFile(path, "not-json\n", { mode: 0o600 });
  await assert.rejects(
    ProcessLock.acquire(path, { pid: 42, token: "unsafe", isProcessAlive: () => false }),
  );
});

test("release never deletes a lock replaced by another owner", async (t) => {
  const path = await lockPath(t);
  const first = await ProcessLock.acquire(path, {
    pid: 42,
    token: "owner-one",
    isProcessAlive: () => true,
  });
  await writeFile(path, '{"pid":43,"token":"owner-two"}\n', { mode: 0o600 });

  await first.release();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pid: 43, token: "owner-two" });
});
