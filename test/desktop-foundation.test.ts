import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { suggestedInstancePort } from "../src/desktop/instance-defaults.js";
import { DesktopInstances } from "../src/desktop/instances.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";
import { ProcessLock } from "../src/process-lock.js";
import { TestMcpClient } from "./support/mcp-client.js";

test("desktop IPC rejects unknown commands, paths and unconfirmed destructive input", () => {
  assert.throws(() => parseDesktopCommand({ type: "exec", command: "anything" }));
  assert.throws(() => parseDesktopCommand({ type: "start", instanceId: "../../other" }));
  assert.throws(() => parseDesktopCommand({ type: "clean", instanceId: crypto.randomUUID() }));
  assert.throws(() => parseDesktopCommand({ type: "snapshot", token: "secret" }));
  assert.deepEqual(parseDesktopCommand({ type: "snapshot" }), { type: "snapshot" });
  const instanceId = crypto.randomUUID();
  assert.equal(
    parseDesktopCommand({
      type: "agent_connection",
      instanceId,
      provider: "claude_code",
      operation: "connect",
    }).type,
    "agent_connection",
  );
  assert.throws(() =>
    parseDesktopCommand({ type: "agent_connection", instanceId, provider: "arbitrary" }),
  );
  assert.throws(() =>
    parseDesktopCommand({
      type: "agent_connection",
      instanceId,
      provider: "claude_code",
      operation: "connect",
      configurationPath: "/arbitrary",
    }),
  );
  assert.throws(() =>
    parseDesktopCommand({
      type: "export_save",
      instanceId,
      previewId: crypto.randomUUID(),
      path: "/arbitrary",
    }),
  );
  assert.throws(() => parseDesktopCommand({ type: "logs", instanceId, query: { limit: 101 } }));
  assert.throws(() =>
    parseDesktopCommand({
      type: "create",
      name: "Test",
      port: 8788,
      requestId: crypto.randomUUID(),
      parentDirectory: "/arbitrary",
    }),
  );
  assert.equal(
    parseDesktopCommand({ type: "logs", instanceId, query: { search: "request", limit: 25 } }).type,
    "logs",
  );
});

test("instance creation retries return the saved instance and reject changed intent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-create-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await DesktopInstances.open(root);
  const input = { requestId: crypto.randomUUID(), name: "Development", port: 18987 };
  const first = await records.create(input);
  const restored = await DesktopInstances.open(root);
  assert.deepEqual(await restored.create(input), first);
  assert.equal(restored.list().length, 1);
  await assert.rejects(restored.create({ ...input, port: 18988 }), /different/u);
});

test("instance records survive restart and reject colliding ports and aliased roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-instances-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instances = await DesktopInstances.open(join(root, "app"));
  const first = await instances.create({ name: "Personal", port: 18787 });
  await instances.updateEnabled(first.id, false);
  const restored = await DesktopInstances.open(join(root, "app"));
  assert.equal(restored.list()[0]?.enabled, false);
  await assert.rejects(restored.create({ name: "Duplicate", port: 18787 }));
  await assert.rejects(
    restored.create({ name: "Nested", port: 18788, parentDirectory: first.stateDirectory }),
  );
  if (process.platform !== "win32") {
    const alias = join(root, "alias");
    await symlink(first.stateDirectory, alias);
    await assert.rejects(restored.create({ name: "Alias", port: 18789, parentDirectory: alias }));
  }
  const second = await restored.create({ name: "Development", port: 18788 });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.stateDirectory, second.stateDirectory);
  assert.equal((await DesktopInstances.open(join(root, "app"))).list().length, 2);
});

test("two desktop gateways expose real MCP; stop and clean preserve the other instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-runtime-"));
  const gateways: DesktopGateway[] = [];
  t.after(async () => {
    await Promise.all(gateways.map((gateway) => gateway.stop()));
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 2; index++) {
    const gateway = new DesktopGateway({
      id: crypto.randomUUID(),
      name: `Test ${index}`,
      stateDirectory: join(root, String(index)),
      port: 0,
      workingDirectory: root,
      environment: {},
    });
    gateways.push(gateway);
    await gateway.start();
  }
  const first = gateways[0];
  const second = gateways[1];
  assert.ok(first && second);
  assert.notEqual(first.snapshot().endpoint, second.snapshot().endpoint);
  const endpoint = second.snapshot().endpoint;
  assert.ok(endpoint);
  const client = new TestMcpClient(endpoint);
  await client.initialize();
  assert.ok((await client.listTools()).some((tool) => tool.name === "register_agent"));
  await assert.rejects(first.clean(), /stopped/u);
  await first.stop();
  await writeFile(join(root, "0", "temporary-state"), "first");
  await writeFile(join(root, "1", "temporary-state"), "second");
  await first.clean();
  assert.equal(await readFile(join(root, "1", "temporary-state"), "utf8"), "second");
  assert.equal(second.snapshot().state, "running");
  assert.ok((await client.listTools()).length > 0);
  await assert.doesNotReject(readFile(join(root, "0", "diagnostics", "events.jsonl")));
});

test("gateway cannot start or clean another process's state and never stops a port occupant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  const gateway = new DesktopGateway({
    id: crypto.randomUUID(),
    name: "Conflict",
    stateDirectory: root,
    port: 0,
    workingDirectory: root,
    environment: {},
  });
  t.after(() => gateway.stop());
  await gateway.start();
  assert.equal(gateway.snapshot().state, "error");
  await assert.rejects(gateway.clean());
  await assert.rejects(gateway.overview());
  await lock.release();
  const occupant = createServer();
  await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => occupant.close(() => resolve())));
  const address = occupant.address();
  assert.ok(address && typeof address !== "string");
  const collision = new DesktopGateway({
    id: crypto.randomUUID(),
    name: "Port conflict",
    stateDirectory: root,
    port: address.port,
    workingDirectory: root,
    environment: {},
  });
  t.after(() => collision.stop());
  await collision.start();
  assert.equal(collision.snapshot().state, "error");
  assert.equal(occupant.listening, true);
  const availableLock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  await availableLock.release();
});

test("instance creation serializes races and refuses corrupted saved state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "app");
  const records = await DesktopInstances.open(directory);
  const outcomes = await Promise.allSettled([
    records.create({ name: "First", port: 18971 }),
    records.create({ name: "Second", port: 18971 }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal((await DesktopInstances.open(directory)).list().length, 1);
  await writeFile(join(directory, "instances.json"), "{broken");
  await assert.rejects(DesktopInstances.open(directory));
});

test("choosing a storage parent does not change its permissions", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-parent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "selected");
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  const records = await DesktopInstances.open(join(root, "app"));
  await records.create({ name: "External", port: 18973, parentDirectory: parent });
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
});

test("the registry cannot redirect Clean to an unrelated directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-desktop-redirect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "app");
  const records = await DesktopInstances.open(directory);
  const instance = await records.create({ name: "Personal", port: 18979 });
  const unrelated = join(root, "unrelated");
  await mkdir(join(unrelated, "workspace"), { recursive: true });
  await writeFile(
    join(directory, "instances.json"),
    JSON.stringify({
      version: 1,
      instances: [
        { ...instance, stateDirectory: unrelated, workingDirectory: join(unrelated, "workspace") },
      ],
    }),
  );
  await assert.rejects(DesktopInstances.open(directory));
});

test("new-instance form skips ports used by saved instances after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-port-suggestion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await DesktopInstances.open(root);
  await registry.create({ name: "Personal", port: 8787 });
  await registry.create({ name: "Test", port: 8788 });
  await registry.create({ name: "Alternate", port: 8790 });
  const restored = await DesktopInstances.open(root);
  assert.equal(suggestedInstancePort(restored.list()), 8789);
  assert.equal(suggestedInstancePort([]), 8788);
});
