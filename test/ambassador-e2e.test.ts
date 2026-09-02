import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import {
  type GatewayApplicationOptions,
  openGatewayApplication,
} from "../src/gateway-application.js";
import type { DeliveryTarget } from "../src/notification-relay.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";

const LOCAL_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "abcdef0123456789abcdef0123456789";
const NOW_SECONDS = 1_788_220_800;
const OPENCLAW = { name: "openclaw-bundle-mcp", version: "0.0.0" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t, {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  const options: GatewayApplicationOptions = {
    localToken: LOCAL_TOKEN,
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
    profilePath: join(root, "delivery-profile.json"),
    workingDirectory: root,
    environment: { EMBASSYS_WEBHOOK_SECRET: WEBHOOK_SECRET },
    centralOrigin: central.apiUrl,
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
  };
  return { root, central, webhook, options };
}

async function enrollWebhook(
  gateway: Awaited<ReturnType<typeof openGatewayApplication>>,
  central: Awaited<ReturnType<typeof startFakeCentral>>,
  webhookUrl: string,
  email: string,
): Promise<TestMcpClient> {
  const client = new TestMcpClient(gateway.endpoint, LOCAL_TOKEN);
  await client.initialize(OPENCLAW);
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhookUrl,
      secret_env: "EMBASSYS_WEBHOOK_SECRET",
    },
  });
  await client.callTool("verify_email", { email, code: central.verificationCode(email) });
  return client;
}

test("registers by client capability, delivers the full webhook, then acknowledges centrally", async (t) => {
  const value = await fixture(t);
  const gateway = await openGatewayApplication(value.options);
  t.after(() => gateway.close());
  const client = await enrollWebhook(
    gateway,
    value.central,
    value.webhook.url,
    "ambassador-webhook@fixture.test",
  );
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "get_my_permissions",
    ],
  );

  const marker = "complete-message-marker-memory-only";
  const messageId = value.central.queueMessage("ambassador-webhook@fixture.test", {
    type: "fixture",
    value: marker,
  });
  const request = await value.webhook.waitForWake();
  assert.equal(request.body.id, messageId);
  assert.equal(JSON.stringify(request.body).includes(marker), true);
  const timestamp = request.headers["x-webhook-timestamp"];
  assert.equal(typeof timestamp, "string");
  assert.equal(request.headers.authorization, `Bearer ${WEBHOOK_SECRET}`);
  assert.equal(request.headers["idempotency-key"], messageId);
  assert.equal(
    request.headers["x-webhook-signature-v2"],
    createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp as string}.${request.rawBody.toString("utf8")}`)
      .digest("hex"),
  );
  for (
    let attempt = 0;
    attempt < 100 && value.central.messageState(messageId) !== "acked";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(value.central.messageState(messageId), "acked");
  assert.equal((await readFile(value.options.journalPath)).includes(Buffer.from(marker)), false);
  assert.equal((await readFile(value.options.profilePath, "utf8")).includes(WEBHOOK_SECRET), false);
  await assert.rejects(client.callTool("poll_messages", { timeout: 0 }));
  await assert.rejects(client.callTool("ack_message", { message_id: messageId }));
});

test("honestly loses a consumed pre-delivery body across restart", async (t) => {
  const value = await fixture(t);
  let firstDeliveries = 0;
  const blocking: DeliveryTarget = {
    async deliver(_message, signal) {
      firstDeliveries += 1;
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
      });
    },
    async close() {},
  };
  const first = await openGatewayApplication({
    ...value.options,
    deliveryTargetFactory: () => blocking,
  });
  await enrollWebhook(first, value.central, value.webhook.url, "ambassador-restart@fixture.test");
  const lostId = value.central.queueMessage("ambassador-restart@fixture.test", {
    value: "restart-loss-marker",
  });
  for (let attempt = 0; attempt < 100 && firstDeliveries === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(firstDeliveries, 1);
  assert.equal(value.central.messageState(lostId), "delivered");
  await first.close();

  let secondDeliveries = 0;
  const second = await openGatewayApplication({
    ...value.options,
    deliveryTargetFactory: () => ({
      async deliver() {
        secondDeliveries += 1;
        return { status: "accepted" };
      },
      async close() {},
    }),
  });
  t.after(() => second.close());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondDeliveries, 0);
  assert.equal(value.central.messageState(lostId), "delivered");
});
