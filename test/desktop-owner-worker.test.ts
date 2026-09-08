import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnerWorkerClient } from "../src/desktop/owner-worker-client.js";
import { ProcessLock } from "../src/process-lock.js";

test("owner worker has its own private protocol, process lock and clean shutdown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "embassys-owner-worker-"));
  const client = new OwnerWorkerClient({
    directory,
    nodePath: process.execPath,
    workerPath: join(process.cwd(), ".test-dist/src/desktop/owner-worker.js"),
    expectedRuntime: process.version,
  });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.ready();
  assert.equal(client.snapshot().status, "signed_out");
  const result = await client.request({ type: "owner_status" });
  assert.equal(result.snapshot.status, "signed_out");
  await assert.rejects(ProcessLock.acquire(join(directory, "owner.lock")));
  await client.close();
  assert.equal(client.snapshot().status, "unavailable");
  assert.equal(client.snapshot().account, undefined);
  await assert.rejects(client.request({ type: "owner_status" }));
  const lock = await ProcessLock.acquire(join(directory, "owner.lock"));
  await lock.release();
});
