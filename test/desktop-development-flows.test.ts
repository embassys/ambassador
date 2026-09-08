import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopGateway } from "../src/desktop/gateway.js";
import type { LocalNotification } from "../src/desktop/notifications.js";
import { openGatewayApplication } from "../src/gateway-application.js";
import { pathsForStateDirectory } from "../src/gateway-paths.js";
import { startFakeCentral } from "./support/fake-central.js";
import { TestMcpClient } from "./support/mcp-client.js";

test("unfinished email-first setup survives gateway restart without polling or dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-onboarding-"));
  const central = await startFakeCentral();
  const instanceId = randomUUID();
  const gateway = new DesktopGateway({
    id: instanceId,
    name: "Onboarding",
    port: 0,
    stateDirectory: root,
    workingDirectory: root,
    environment: {},
    testOverrides: { centralOrigin: central.apiUrl, nowSeconds: () => 1_788_220_800 },
  });
  t.after(async () => {
    await gateway.stop();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  await gateway.start();
  await gateway.desktopCommand({
    type: "enrollment_register",
    instanceId,
    email: "account-first@fixture.test",
  });
  await gateway.desktopCommand({
    type: "enrollment_verify",
    instanceId,
    code: central.verificationCode("account-first@fixture.test"),
  });
  await gateway.stop();
  const before = central.requests().length;
  await gateway.start();
  assert.equal((await gateway.overview()).enrollment.verified, true);
  assert.equal(
    (
      (await gateway.desktopCommand({ type: "enrollment_status", instanceId })) as {
        needsExecutor: boolean;
      }
    ).needsExecutor,
    true,
  );
  assert.equal(central.requests().length, before);
  const endpoint = gateway.snapshot().endpoint;
  assert.ok(endpoint);
  const mcp = new TestMcpClient(endpoint);
  await mcp.initialize({ name: "claude-code", version: "fixture" });
  await assert.rejects(mcp.callTool("get_my_permissions", {}), /Set up this device/);
  await gateway.desktopCommand({ type: "enrollment_executor", instanceId, executor: "claude" });
  await assert.doesNotReject(mcp.callTool("get_my_permissions", {}));
});

test("CLI verification can finish an email-first app registration without selecting a provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-email-first-cli-"));
  const central = await startFakeCentral();
  const path = join(root, "registration.json");
  const common = {
    ...pathsForStateDirectory(root),
    workingDirectory: root,
    environment: {},
    centralOrigin: central.apiUrl,
    nowSeconds: () => 1_788_220_800,
    localMcpPort: 0,
  };
  let application = await openGatewayApplication({ ...common, desktopRegistrationPath: path });
  t.after(async () => {
    await application.close();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  await application.desktop?.registration.register({ email: "email-first-cli@fixture.test" });
  await application.close();
  application = await openGatewayApplication({ ...common, toolRegistrationPath: path });
  const mcp = new TestMcpClient(application.endpoint);
  await mcp.initialize({ name: "claude-code", version: "fixture" });
  await mcp.callTool("verify_email", {
    email: "email-first-cli@fixture.test",
    code: central.verificationCode("email-first-cli@fixture.test"),
  });
  assert.equal(application.localOverview().enrollment.verified, true);
  assert.equal(application.desktop?.registration.needsExecutor, true);
  assert.equal(central.requests().length, 2);
  await assert.rejects(mcp.callTool("get_my_permissions", {}), /Set up this device/);
});

test("desktop pauses a mismatched executor before dispatch and resumes queued work after repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-desktop-guard-flow-"));
  const central = await startFakeCentral();
  let allowed = false;
  let delivered = 0;
  const instanceId = randomUUID();
  const gateway = new DesktopGateway({
    id: instanceId,
    name: "Guarded",
    port: 0,
    stateDirectory: root,
    workingDirectory: root,
    environment: {},
    beforeDirectDelivery: async (context) => {
      assert.equal(context.agent, "claude");
      if (!allowed) throw new Error("wrong endpoint");
    },
    testOverrides: {
      centralOrigin: central.apiUrl,
      nowSeconds: () => 1_788_220_800,
      deliveryTargetFactory: () => ({
        async deliver(message) {
          assert.equal(message.payload.type, "action_call");
          delivered++;
          return { status: "completed" };
        },
        async close() {},
      }),
    },
  });
  t.after(async () => {
    await gateway.stop();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  await gateway.start();
  await gateway.desktopCommand({
    type: "enrollment_register",
    instanceId,
    email: "guarded@fixture.test",
    executor: "claude",
  });
  await gateway.desktopCommand({
    type: "enrollment_verify",
    instanceId,
    code: central.verificationCode("guarded@fixture.test"),
  });
  central.seedClient("peer@fixture.test");
  central.queueMessage(
    "guarded@fixture.test",
    {
      type: "action_call",
      call_id: randomUUID(),
      action_type: "get_phone_number",
      payload: { reason: "fixture" },
    },
    "peer@fixture.test",
    "get_phone_number",
  );
  for (let i = 0; i < 400 && !gateway.snapshot().notice; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(delivered, 0);
  assert.equal(gateway.snapshot().state, "running");
  assert.match(gateway.snapshot().notice ?? "", /connection.*Agents/);
  assert.equal((await gateway.overview()).pendingCalls, 1);
  central.queueMessage(
    "guarded@fixture.test",
    {
      type: "action_response",
      call_id: randomUUID(),
      action_type: "get_phone_number",
      status: "success",
      result: { phone_number: "fixture" },
    },
    "peer@fixture.test",
    "get_phone_number",
  );
  for (let i = 0; i < 400 && (await gateway.overview()).receivedResults === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await gateway.overview()).receivedResults, 1);
  await gateway.stop();
  allowed = true;
  await gateway.start();
  for (let i = 0; i < 400 && delivered === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(delivered, 1);
  assert.equal(gateway.snapshot().notice, undefined);
});

test("app enrollment is shared with MCP; local activity pages and notifications do not consume work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-app-flows-"));
  const central = await startFakeCentral();
  const events: LocalNotification[] = [];
  const controller = new AbortController();
  let saved: string | undefined;
  const options = {
    ...pathsForStateDirectory(root),
    desktopRegistrationPath: join(root, "registration.json"),
    workingDirectory: root,
    environment: {},
    centralOrigin: central.apiUrl,
    nowSeconds: () => 1_788_220_800,
    credentialStore: {
      load: async () => saved,
      save: async (value: string) => {
        saved = value;
      },
    },
    localMcpPort: 0,
    signal: controller.signal,
    onDesktopNotification: (event: LocalNotification) => {
      events.push(event);
    },
    deliveryTargetFactory: () => ({
      deliver: async () => ({ status: "completed" as const }),
      close: async () => {},
    }),
    acpSessionControllerFactory: () => ({
      show: async () => [],
      delete: async () => "unsupported" as const,
    }),
  };
  const application = await openGatewayApplication(options);
  t.after(async () => {
    controller.abort();
    await application.close();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  const desktop = application.desktop;
  assert.ok(desktop);
  assert.equal((await desktop.permissions()).state, "not_registered");
  assert.equal(desktop.activity("incoming").state, "not_registered");
  const mcp = new TestMcpClient(application.endpoint);
  await mcp.initialize({ name: "claude-code", version: "qualification" });
  await assert.rejects(
    mcp.callTool("register_agent", { email: "foreign@fixture.test" }),
    /Account.*Set up this device/,
  );
  assert.equal(central.requests().length, 0);
  await desktop.registration.register({ email: "app@fixture.test", executor: "claude" });
  await desktop.registration.verify(central.verificationCode("app@fixture.test"));
  assert.equal(application.localOverview().enrollment.email, "app@fixture.test");
  await assert.rejects(
    mcp.callTool("register_agent", { email: "foreign@fixture.test" }),
    /already enrolled/,
  );
  await assert.doesNotReject(mcp.callTool("get_my_permissions", {}));
  assert.equal((await desktop.permissions()).state, "ready");
  central.seedClient("requester@fixture.test");
  const requester = central.clientForVerifiedEmail("requester@fixture.test");
  const permission = await requester.protectedFetch("/api/request_permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target_email: "app@fixture.test", action_type: "get_phone_number" }),
  });
  assert.equal(permission.status, 200);
  const permissions = await desktop.permissions();
  assert.equal(permissions.items.length, 1);
  assert.equal(permissions.items[0]?.status, "pending");
  for (let i = 0; i < 53; i++)
    central.queueMessage(
      "app@fixture.test",
      {
        type: "action_call",
        call_id: randomUUID(),
        action_type: "get_phone_number",
        payload: { reason: "private body" },
      },
      "requester@fixture.test",
      "get_phone_number",
    );
  central.queueMessage(
    "app@fixture.test",
    {
      type: "action_response",
      call_id: randomUUID(),
      action_type: "get_phone_number",
      status: "success",
      result: { phone_number: "private result" },
    },
    "requester@fixture.test",
    "get_phone_number",
  );
  for (let i = 0; i < 400 && events.length < 54; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.length, 54);
  assert.equal(new Set(events.map((event) => event.id)).size, 54);
  const first = desktop.activity("incoming");
  const second = desktop.activity("incoming", first.nextCursor);
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 3);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 53);
  assert.equal(desktop.activity("results").items.length, 1);
  assert.equal(desktop.activity("outgoing").items.length, 0);
  assert.equal(desktop.activity("questions").items.length, 0);
  assert.doesNotMatch(
    JSON.stringify([first, second, desktop.activity("results"), events]),
    /private body|private result/,
  );
  assert.equal(application.localOverview().pendingCalls, 53);
  assert.equal(application.localOverview().receivedResults, 1);
  await central.close();
  assert.equal((await desktop.permissions()).state, "unavailable");
});

test("private desktop reads and registration commands never start a stopped server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-stopped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instanceId = randomUUID();
  const gateway = new DesktopGateway({
    id: instanceId,
    name: "Stopped",
    stateDirectory: root,
    port: 0,
    workingDirectory: root,
    environment: {},
  });
  for (const command of [
    { type: "permissions" as const, instanceId },
    { type: "activity" as const, instanceId, kind: "incoming" as const },
    { type: "enrollment_status" as const, instanceId },
    {
      type: "enrollment_register" as const,
      instanceId,
      email: "app@fixture.test",
      executor: "claude" as const,
    },
  ]) {
    assert.equal(((await gateway.desktopCommand(command)) as { state: string }).state, "stopped");
    assert.equal(gateway.snapshot().state, "stopped");
  }
});
