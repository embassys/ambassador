import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { DeliveryProfileStore } from "../src/delivery-profile.js";
import { desktopCredentialStores } from "../src/desktop/credential-stores.js";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { DesktopInstances } from "../src/desktop/instances.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";
import { pathsForStateDirectory } from "../src/gateway-paths.js";
import { gatewayWorkingDirectory } from "../src/gateway-working-directory.js";
import { LocalControlClient } from "../src/local-control.js";
import { startFakeCentral } from "./support/fake-central.js";
import { TestMcpClient } from "./support/mcp-client.js";

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < (process.platform === "win32" ? 6000 : 1000); attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The handoff did not finish in time.");
}

test("CLI → app → CLI retains encrypted identity, pending calls, registration and executor directory", {
  timeout: process.platform === "win32" ? 240000 : 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-roundtrip-"));
  const central = await startFakeCentral();
  const stateRoot = join(root, "shared");
  const paths = pathsForStateDirectory(stateRoot);
  const stores = desktopCredentialStores(paths);
  const controller = new AbortController();
  let gateway: DesktopGateway | undefined;
  const cliRuns: Promise<number>[] = [];
  t.after(async () => {
    controller.abort();
    await Promise.all(cliRuns);
    await gateway?.stop();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  const overrides = {
    centralOrigin: central.apiUrl,
    stateRoot,
    ...stores,
    localMcpPort: 0,
    nowSeconds: () => 1_788_220_800,
    deliveryTargetFactory: () => ({
      deliver: async () => ({ status: "completed" as const }),
      close: async () => {},
    }),
  };
  let output = "";
  const io = {
    stdout: {
      write: (value: string) => {
        output += value;
        return true;
      },
    },
    stderr: { write: (_value: string) => true },
  };
  const first = runCli(["start"], {
    io,
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: overrides,
  });
  cliRuns.push(first);
  await eventually(() => output.includes("MCP endpoint:"));
  const endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(output)?.[1];
  assert.ok(endpoint);
  let mcp = new TestMcpClient(endpoint);
  await mcp.initialize({ name: "claude-code", version: "handoff-test" });
  const email = "shared@fixture.test";
  await mcp.callTool("register_agent", { email });
  const id = randomUUID();
  gateway = new DesktopGateway({
    id,
    name: "Shared",
    stateDirectory: stateRoot,
    port: Number(new URL(endpoint).port),
    workingDirectory: join(stateRoot, "workspace"),
    environment: {},
    testOverrides: overrides,
  });
  const external = await gateway.externalProcess();
  assert.ok(external.processInstanceId);
  await assert.rejects(gateway.stopExternal(randomUUID()));
  assert.equal((await gateway.externalProcess()).processInstanceId, external.processInstanceId);
  await gateway.stopExternal(external.processInstanceId);
  assert.equal(await first, 0);
  await gateway.start();
  assert.equal(gateway.snapshot().state, "running");
  const registration = (await gateway.desktopCommand({
    type: "enrollment_status",
    instanceId: id,
  })) as { phase: string; email: string };
  assert.equal(registration.phase, "awaiting_code");
  assert.equal(registration.email, email);
  await gateway.desktopCommand({
    type: "enrollment_verify",
    instanceId: id,
    code: central.verificationCode(email),
  });
  assert.equal((await gateway.overview()).enrollment.email, email);
  const encrypted = await readFile(paths.credentialPath, "utf8");
  assert.doesNotMatch(encrypted, /access_token|private_key|314159/u);
  central.seedClient("peer@fixture.test");
  const callId = randomUUID();
  central.queueMessage(
    email,
    {
      type: "action_call",
      call_id: callId,
      action_type: "get_phone_number",
      payload: { reason: "Handoff test" },
    },
    "peer@fixture.test",
    "get_phone_number",
  );
  await eventually(async () => (await gateway?.overview())?.pendingCalls === 1);
  const appEndpoint = gateway.snapshot().endpoint;
  assert.ok(appEndpoint);
  const secret = await stores.localControlSecretStore.load();
  assert.ok(secret);
  const control = new LocalControlClient(appEndpoint, secret);
  await control.stopProcess(await control.getProcessInstance());
  await eventually(() => gateway?.snapshot().state === "stopped");
  assert.equal(gateway.snapshot().stopReason, "handoff");
  output = "";
  const nextCwd = join(root, "another-directory");
  await mkdir(nextCwd);
  const second = runCli(["start"], {
    io,
    env: {},
    cwd: nextCwd,
    signal: controller.signal,
    testOverrides: overrides,
  });
  cliRuns.push(second);
  await eventually(() => output.includes("MCP endpoint:"));
  const secondEndpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(output)?.[1];
  assert.ok(secondEndpoint);
  mcp = new TestMcpClient(secondEndpoint);
  await mcp.initialize({ name: "claude-code", version: "handoff-test" });
  assert.doesNotMatch(JSON.stringify(await mcp.callTool("get_my_permissions", {})), /not_enrolled/);
  assert.match(
    JSON.stringify(await mcp.callTool("message_box", { type: "inbox" })),
    new RegExp(callId),
  );
  assert.equal(await readFile(paths.credentialPath, "utf8"), encrypted);
  const profile = await new DeliveryProfileStore(paths.profilePath).load();
  assert.equal(profile?.mode, "direct");
  assert.equal(profile?.mode === "direct" && profile.working_directory, await realpath(root));
  assert.equal(
    central.requests().filter((request) => request.path === "/api/register_agent").length,
    1,
  );
  assert.equal(
    central.requests().filter((request) => request.path === "/api/verify_email").length,
    1,
  );
});

test("shared installation rejects a final directory symlink", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-cli-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "alias"));
  await assert.rejects(
    DesktopInstances.open(join(root, "desktop"), { cliDirectory: join(root, "alias") }),
    /alias/,
  );
});

test("the renderer cannot bypass the native handoff confirmation", () => {
  assert.throws(() =>
    parseDesktopCommand({
      type: "external_stop",
      instanceId: randomUUID(),
      processInstanceId: randomUUID(),
    }),
  );
  assert.throws(() => parseDesktopCommand({ type: "attach_cli", stateDirectory: "/other" }));
});

test("desktop links the fixed CLI installation without moving existing instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliDirectory = join(root, "cli");
  let instances = await DesktopInstances.open(join(root, "desktop"), { cliDirectory });
  const isolated = await instances.create({ name: "Existing", port: 8787 });
  await instances.updateEnabled(isolated.id, false);
  const shared = await instances.attachCli();
  assert.equal(shared.source, "cli");
  assert.equal(shared.port, 8787);
  assert.equal(shared.enabled, false);
  assert.equal(shared.stateDirectory, await realpath(cliDirectory));
  assert.equal((await instances.attachCli()).id, shared.id);
  instances = await DesktopInstances.open(join(root, "desktop"), { cliDirectory });
  assert.equal(instances.list()[0]?.stateDirectory, isolated.stateDirectory);
  assert.equal(instances.list().length, 2);
  await assert.rejects(
    DesktopInstances.open(join(root, "desktop"), { cliDirectory: join(root, "wrong") }),
  );
  await assert.rejects(instances.create({ name: "Conflict", port: 8787 }));
});

test("both hosts reuse the saved canonical executor directory and reject a missing directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "delivery-profile.json");
  const workspace = join(root, "original");
  await mkdir(workspace);
  assert.equal(await gatewayWorkingDirectory(profilePath, root), await realpath(root));
  await new DeliveryProfileStore(profilePath).save({
    version: 1,
    mode: "direct",
    agent_kind: "claude",
    working_directory: await realpath(workspace),
  });
  assert.equal(await gatewayWorkingDirectory(profilePath, root), await realpath(workspace));
  await rm(workspace, { recursive: true });
  await assert.rejects(gatewayWorkingDirectory(profilePath, root));
});
