import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { type McpTool, TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";

const WEBHOOK_TOKEN = "fixture-webhook-token-never-persist";
const EMAIL = "fixture-agent@example.test";
const CODE = "246810";
const MESSAGE_ID = "message_fixture_01";
const MESSAGE_CONTENT = "fixture message body must stay out of gateway state";

function propertyNames(tool: McpTool): string[] {
  const properties = tool.inputSchema.properties;
  assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
  return Object.keys(properties as Record<string, unknown>).sort();
}

async function scanFiles(root: string, markers: string[]): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const bytes = await readFile(`${entry.parentPath}/${entry.name}`);
    for (const marker of markers) {
      assert.ok(!bytes.includes(Buffer.from(marker)), `${entry.name} contains forbidden plaintext`);
    }
  }
}

test("enrolls one identity, relays an ID, and keeps credentials and MCP bodies transient", async (t) => {
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  central.injectMessage(MESSAGE_ID, MESSAGE_CONTENT);

  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });

  const malformedMarker = "malformed-body-must-not-be-reflected";
  const unauthenticated = await fetch(gateway.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: malformedMarker,
  });
  assert.equal(unauthenticated.status, 401);
  assert.ok(!(await unauthenticated.text()).includes(malformedMarker));

  const wrongOrigin = await fetch(gateway.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${WEBHOOK_TOKEN}`,
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(wrongOrigin.status, 403);

  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN);
  await client.initialize();
  const bootstrapTools = await client.listTools();
  assert.deepEqual(bootstrapTools.map((tool) => tool.name).sort(), [
    "register_agent",
    "resend_verification",
    "verify_email",
  ]);
  for (const tool of bootstrapTools) {
    assert.ok(!propertyNames(tool).includes("token"));
  }

  await assert.rejects(
    client.callTool("resend_verification", { email: EMAIL }),
    /credential|upstream|tool/iu,
  );

  await delay(100);
  assert.equal(central.pollCount(), 0, "central polling started before verification");

  const registration = await client.callTool("register_agent", {
    username: "fixture-agent",
    email: EMAIL,
    display_name: "Fixture Agent",
  });
  assert.equal(registration.agent_id, "agent_fixture");
  assert.ok(!Object.hasOwn(registration, "token"));

  const verification = await client.callTool("verify_email", { email: EMAIL, code: CODE });
  assert.deepEqual(verification, {
    verified: true,
    agent_id: "agent_fixture",
    username: "fixture-agent",
    message: "Email verified successfully.",
  });
  assert.ok(!JSON.stringify(verification).includes(central.jwt));
  for (const call of central.calls.filter((item) =>
    ["register_agent", "resend_verification", "verify_email"].includes(item.name),
  )) {
    assert.ok(!Object.hasOwn(call.args, "token"));
  }

  const wake = await webhook.waitForWake();
  assert.equal(wake.headers.authorization, `Bearer ${WEBHOOK_TOKEN}`);
  assert.equal(wake.headers["idempotency-key"], MESSAGE_ID);
  assert.equal(wake.body.agentId, undefined);
  assert.equal(wake.body.deliver, false);
  assert.equal(wake.body.wakeMode, "now");
  assert.match(String(wake.body.message), new RegExp(MESSAGE_ID, "u"));
  assert.deepEqual(central.messageState(MESSAGE_ID), {
    id: MESSAGE_ID,
    content: MESSAGE_CONTENT,
    notificationAcknowledged: true,
    contentAcknowledged: false,
  });

  const authenticatedTools = await client.listTools();
  assert.deepEqual(authenticatedTools.map((tool) => tool.name).sort(), [
    "ack_message",
    "poll_messages",
  ]);
  for (const tool of authenticatedTools) {
    assert.ok(!propertyNames(tool).includes("token"));
  }

  const polled = await client.callTool("poll_messages", { timeout: 0 });
  assert.deepEqual(polled, {
    messages: [{ id: MESSAGE_ID, content: MESSAGE_CONTENT }],
  });
  await client.callTool("ack_message", { message_id: MESSAGE_ID });
  assert.equal(central.messageState(MESSAGE_ID).contentAcknowledged, true);

  const authenticatedCalls = central.calls.filter((call) =>
    ["poll_messages", "ack_message"].includes(call.name),
  );
  assert.equal(authenticatedCalls.length, 2);
  for (const call of authenticatedCalls) {
    assert.equal(call.args.token, central.jwt);
  }

  assert.equal(await gateway.stop(), 0);
  const forbidden = [WEBHOOK_TOKEN, central.jwt, EMAIL, CODE, MESSAGE_CONTENT];
  await scanFiles(gateway.stateRoot, forbidden);
  for (const marker of forbidden) {
    assert.ok(!gateway.stdout().includes(marker));
    assert.ok(!gateway.stderr().includes(marker));
  }
});
