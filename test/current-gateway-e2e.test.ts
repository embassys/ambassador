import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openGatewayApplication } from "../src/gateway-application.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";

const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_SECONDS = 1_788_220_800;

test("I02-G01 gateway enrolls, exposes seven fixed tools, consumes, wakes, and acknowledges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-current-gateway-"));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const paths = {
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
  };
  const gateway = await openGatewayApplication({
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    ...paths,
    centralOrigin: central.apiUrl,
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
  });
  t.after(async () => await gateway.close());
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN);
  await client.initialize();
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["register_agent", "verify_email", "resend_verification"],
  );

  const email = "gateway-current@fixture.test";
  await client.callTool("register_agent", { email, display_name: "Current gateway" });
  const verified = await client.callTool("verify_email", {
    email,
    code: central.verificationCode(email),
  });
  assert.deepEqual(Object.keys(verified).sort(), ["agent_id", "email", "message", "verified"]);
  assert.equal(JSON.stringify(verified).includes("token"), false);

  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "poll_messages",
      "get_my_permissions",
      "ack_message",
    ],
  );
  const catalog = await client.callTool("list_action_types", {});
  assert.equal(Array.isArray(catalog.action_types), true);

  const marker = "current-message-marker-must-remain-memory-only";
  const messageId = central.queueMessage(email, { type: "fixture", value: marker });
  const wake = await webhook.waitForWake();
  assert.equal(wake.rawBody.includes(Buffer.from(marker, "utf8")), false);
  assert.equal(JSON.stringify(wake.body).includes(messageId), true);
  const polled = await client.callTool("poll_messages", { timeout: 0 });
  const messages = polled.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.id, messageId);
  assert.equal(JSON.stringify(messages[0]).includes(marker), true);
  const acknowledged = await client.callTool("ack_message", { message_id: messageId });
  assert.deepEqual(acknowledged, { message_id: messageId, status: "acked" });
  assert.equal(central.messageState(messageId), "acked");

  const journalBytes = await readFile(paths.journalPath);
  assert.equal(journalBytes.includes(Buffer.from(marker, "utf8")), false);
});

test("I02-G02 restart reloads the bound credential and honestly drops a consumed body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-current-restart-"));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const options = {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
    centralOrigin: central.apiUrl,
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
  } as const;

  const first = await openGatewayApplication(options);
  const firstClient = new TestMcpClient(first.endpoint, WEBHOOK_TOKEN);
  await firstClient.initialize();
  const email = "gateway-restart@fixture.test";
  await firstClient.callTool("register_agent", { email });
  await firstClient.callTool("verify_email", { email, code: central.verificationCode(email) });
  const lostId = central.queueMessage(email, { type: "fixture", value: "restart-loss-marker" });
  await webhook.waitForWake();
  assert.equal(central.messageState(lostId), "delivered");
  await first.close();

  const second = await openGatewayApplication(options);
  t.after(async () => await second.close());
  const secondClient = new TestMcpClient(second.endpoint, WEBHOOK_TOKEN);
  await secondClient.initialize();
  assert.equal((await secondClient.listTools())[0]?.name, "list_action_types");
  assert.deepEqual(await secondClient.callTool("poll_messages", { timeout: 0 }), { messages: [] });
  assert.equal(central.messageState(lostId), "delivered");
  assert.equal(
    central
      .requests()
      .some((request) => request.path.includes("delivered") || request.path.includes("lease")),
    false,
  );
});
