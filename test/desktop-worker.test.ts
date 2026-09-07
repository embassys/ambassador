import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopGatewayClient } from "../src/desktop/worker-client.js";
import { ProcessLock } from "../src/process-lock.js";

test("worker startup rejects an incompatible runtime before accepting commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-worker-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerPath = join(root, "fixture.cjs");
  await writeFile(
    workerPath,
    `process.on('message', (message) => {
    process.send({protocol: 1, type: 'ready', runtime: 'v0.0.0', snapshot: {id: message.instance.id, state: 'stopped'}});
  }); process.on('disconnect', () => process.exit(0));`,
  );
  const client = new DesktopGatewayClient({
    nodePath: process.execPath,
    workerPath,
    expectedRuntime: process.version,
    instance: {
      id: randomUUID(),
      name: "Version probe",
      port: 19872,
      stateDirectory: root,
      workingDirectory: join(root, "workspace"),
      enabled: false,
      createdAt: new Date().toISOString(),
    },
  });
  t.after(() => client.close());
  await assert.rejects(client.ready(), /runtime/);
  assert.equal(client.snapshot().state, "error");
});

test("gateway worker completes a private handshake and exits when its parent IPC closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-worker-"));
  const child = fork(join(process.cwd(), ".test-dist/src/desktop/worker.js"), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.connected) child.disconnect();
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });
  const init = once(child, "message");
  child.send({
    protocol: 1,
    type: "initialize",
    instance: {
      id: randomUUID(),
      name: "Worker",
      port: 19871,
      stateDirectory: root,
      workingDirectory: join(root, "workspace"),
      enabled: false,
      createdAt: new Date().toISOString(),
    },
  });
  const [reply] = await init;
  assert.equal((reply as { type: string }).type, "ready");
  const exit = once(child, "exit");
  child.disconnect();
  await exit;
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  await lock.release();
});

test("worker client serializes lifecycle and rejects calls after close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-worker-client-"));
  const id = randomUUID();
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const client = new DesktopGatewayClient({
    nodePath: process.execPath,
    workerPath: join(process.cwd(), ".test-dist/src/desktop/worker.js"),
    instance: {
      id,
      name: "Client",
      port,
      stateDirectory: root,
      workingDirectory: join(root, "workspace"),
      enabled: false,
      createdAt: new Date().toISOString(),
    },
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.ready();
  await client.request({ type: "start", instanceId: id });
  assert.equal(client.snapshot().state, "running");
  await writeFile(join(root, "preserved-work"), "pending work marker");
  const beforeClear = await client.request({ type: "logs", instanceId: id });
  assert.match(JSON.stringify(beforeClear), /desktop.gateway/u);
  assert.deepEqual(await client.request({ type: "clear_logs", instanceId: id }), { cleared: true });
  assert.equal(client.snapshot().state, "running");
  assert.equal(await readFile(join(root, "preserved-work"), "utf8"), "pending work marker");
  await client.request({ type: "stop", instanceId: id });
  assert.equal(client.snapshot().state, "stopped");
  const other = join(root, "other-instance", "diagnostics");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "events.jsonl"), "other instance");
  const held = await ProcessLock.acquire(join(root, "ambassador.lock"));
  await assert.rejects(client.request({ type: "clear_logs", instanceId: id }));
  await held.release();
  await client.request({ type: "clear_logs", instanceId: id });
  assert.equal(await readFile(join(root, "diagnostics", "events.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(other, "events.jsonl"), "utf8"), "other instance");
  await client.request({ type: "start", instanceId: id });
  await client.close();
  await assert.rejects(client.request({ type: "start", instanceId: id }));
  await delay(20);
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  await lock.release();
});
