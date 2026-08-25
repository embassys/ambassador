import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";

const FIXTURE_URL = process.env.A2A_FASTMCP_FIXTURE_URL;
const TEST_KEY = "central-fixture-control";
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const EMAIL = "fastmcp-agent@example.test";
const USERNAME = "fastmcp-agent";
const CODE = "246810";
const MESSAGE_ID = "fastmcp_message_01";
const MESSAGE_CONTENT = "FastMCP message content must stay out of gateway state";

async function control<T>(baseUrl: string, path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "X-A2A-Test-Key": TEST_KEY,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}

async function waitForAcknowledgement(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspection = await control<{
      messages: Array<{ id: string; notification_acknowledged: boolean }>;
    }>(baseUrl, "/__test/inspect", { message_id: MESSAGE_ID });
    if (inspection.messages[0]?.notification_acknowledged === true) return;
    await delay(20);
  }
  assert.fail("notification acknowledgement was not observed");
}

async function assertFilesExclude(root: string, markers: string[]): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(entry.parentPath, entry.name));
    for (const marker of markers) assert.ok(!bytes.includes(Buffer.from(marker)));
  }
}

test("enrolls and relays through the pinned FastMCP fixture", {
  skip: FIXTURE_URL === undefined,
}, async (t) => {
  assert.ok(FIXTURE_URL !== undefined);
  await control(FIXTURE_URL, "/__test/reset", {});
  const webhook = await startFakeWebhook(t);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: FIXTURE_URL,
    centralMcpUrl: new URL("/mcp", FIXTURE_URL).toString(),
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN);
  await client.initialize();

  const registration = await client.callTool("register_agent", {
    username: USERNAME,
    email: EMAIL,
    display_name: "FastMCP Agent",
  });
  assert.equal(typeof registration.agent_id, "string");
  const agentId = registration.agent_id as string;
  const verificationCode = await control<{ code: string }>(
    FIXTURE_URL,
    "/__test/verification-code",
    { email: EMAIL },
  );
  assert.equal(verificationCode.code, CODE);

  const listChanged = client.waitForNotification("notifications/tools/list_changed");
  const verification = await client.callTool("verify_email", { email: EMAIL, code: CODE });
  assert.equal(verification.verified, true);
  assert.equal(Object.hasOwn(verification, "token"), false);
  await listChanged;

  await control(FIXTURE_URL, "/__test/messages", {
    recipient_agent_id: agentId,
    content: MESSAGE_CONTENT,
    message_id: MESSAGE_ID,
  });
  const wake = await webhook.waitForWake();
  assert.equal(wake.headers["idempotency-key"], MESSAGE_ID);
  await waitForAcknowledgement(FIXTURE_URL);

  const polled = await client.callTool("poll_messages", { timeout: 0 });
  assert.ok(Array.isArray(polled.messages));
  assert.equal((polled.messages[0] as { id?: unknown }).id, MESSAGE_ID);
  assert.equal((polled.messages[0] as { content?: unknown }).content, MESSAGE_CONTENT);
  await client.callTool("ack_message", { message_id: MESSAGE_ID });

  const inspection = await control<{
    messages: Array<{ content_acknowledged: boolean }>;
  }>(FIXTURE_URL, "/__test/inspect", { message_id: MESSAGE_ID });
  assert.equal(inspection.messages[0]?.content_acknowledged, true);
  assert.equal(await gateway.stop(), 0);
  await assertFilesExclude(gateway.artifactRoot, [EMAIL, CODE, USERNAME, agentId, MESSAGE_CONTENT]);
});
