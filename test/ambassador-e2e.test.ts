import assert from "node:assert/strict";
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

const WEBHOOK_SECRET = "abcdef0123456789abcdef0123456789";
const NOW_SECONDS = 1_788_220_800;
const OPENCLAW = { name: "openclaw-bundle-mcp", version: "0.0.0" };
const JSON_HEADERS = { "content-type": "application/json" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-e2e-"));
  const gateways = new Set<Awaited<ReturnType<typeof openGatewayApplication>>>();
  const central = await startFakeCentral();
  const webhook = await startFakeWebhook(undefined, {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
    contract: "openclaw-agent",
  });
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await webhook.close();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  const options: GatewayApplicationOptions = {
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
    credentialKeyPath: join(root, "central-credential.key"),
    webhookSecretPath: join(root, "webhook-secret.json"),
    webhookSecretKeyPath: join(root, "webhook-secret.key"),
    profilePath: join(root, "delivery-profile.json"),
    workingDirectory: root,
    environment: {},
    webhookSecretStore: {
      async load() {
        return WEBHOOK_SECRET;
      },
      async createOrLoad() {
        return WEBHOOK_SECRET;
      },
    },
    centralOrigin: central.apiUrl,
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
  };
  return {
    root,
    central,
    webhook,
    options,
    trackGateway(gateway: Awaited<ReturnType<typeof openGatewayApplication>>) {
      gateways.add(gateway);
      return gateway;
    },
  };
}

async function enrollWebhook(
  gateway: Awaited<ReturnType<typeof openGatewayApplication>>,
  central: Awaited<ReturnType<typeof startFakeCentral>>,
  webhookUrl: string,
  email: string,
): Promise<TestMcpClient> {
  const client = new TestMcpClient(gateway.endpoint);
  await client.initialize(OPENCLAW);
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhookUrl,
    },
  });
  await client.callTool("verify_email", { email, code: central.verificationCode(email) });
  return client;
}

test("registers by client capability, delivers the full webhook, then acknowledges centrally", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
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
      "submit_action_result",
      "get_my_permissions",
    ],
  );

  const marker = "complete-message-marker-memory-only";
  const messageId = value.central.queueMessage("ambassador-webhook@fixture.test", {
    type: "fixture",
    value: marker,
  });
  const request = await value.webhook.waitForWake();
  assert.equal(request.ambassadorMessage.id, messageId);
  assert.equal(JSON.stringify(request.body).includes(marker), true);
  assert.equal(request.headers.authorization, `Bearer ${WEBHOOK_SECRET}`);
  assert.equal(request.headers["idempotency-key"], messageId);
  assert.equal(request.headers["x-webhook-signature-v2"], undefined);
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

test("returns a correlated action result from the target MCP tool to the requester", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const targetEmail = "ambassador-result-target@fixture.test";
  const target = await enrollWebhook(gateway, value.central, value.webhook.url, targetEmail);
  const requester = value.central.seedClient("ambassador-result-requester@fixture.test");

  const permissionResponse = await requester.protectedFetch("/api/request_permission", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ target_email: targetEmail, action_type: "get_phone_number" }),
  });
  assert.equal(permissionResponse.status, 200);
  const permission = (await permissionResponse.json()) as Record<string, unknown>;
  assert.equal(typeof permission.permission_id, "string");
  const permissionWake = await value.webhook.waitForWake();
  assert.equal(
    (permissionWake.ambassadorMessage.payload as Record<string, unknown>).type,
    "permission_request",
  );

  const decided = await target.callTool("respond_to_permission", {
    permission_id: permission.permission_id,
    decision: "granted",
  });
  assert.equal(decided.status, "granted");
  const requesterPermissionPoll = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const requesterPermissionMessages = (
    (await requesterPermissionPoll.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(requesterPermissionMessages.length, 1);

  const actionResponse = await requester.protectedFetch("/api/call_action", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      target_email: targetEmail,
      action_type: "get_phone_number",
      payload: { reason: "deterministic result round trip" },
    }),
  });
  assert.equal(actionResponse.status, 200);
  const action = (await actionResponse.json()) as Record<string, unknown>;
  assert.equal(typeof action.call_id, "string");
  const actionWake = await value.webhook.waitForWake();
  assert.equal(
    (actionWake.ambassadorMessage.payload as Record<string, unknown>).call_id,
    action.call_id,
  );

  const submitted = await target.callTool("submit_action_result", {
    call_id: action.call_id,
    result: { phone_number: "+447700900001" },
    status: "success",
  });
  assert.equal(submitted.call_id, action.call_id);
  assert.equal(submitted.status, "completed");

  const requesterResultPoll = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const requesterResultMessages = (
    (await requesterResultPoll.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(requesterResultMessages.length, 1);
  assert.deepEqual(requesterResultMessages[0]?.payload, {
    type: "action_response",
    call_id: action.call_id,
    action_type: "get_phone_number",
    status: "success",
    result: { phone_number: "+447700900001" },
  });
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
  const first = value.trackGateway(
    await openGatewayApplication({
      ...value.options,
      deliveryTargetFactory: () => blocking,
    }),
  );
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
  value.trackGateway(
    await openGatewayApplication({
      ...value.options,
      deliveryTargetFactory: () => ({
        async deliver() {
          secondDeliveries += 1;
          return { status: "accepted" };
        },
        async close() {},
      }),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondDeliveries, 0);
  assert.equal(value.central.messageState(lostId), "delivered");
});
