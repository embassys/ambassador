import assert from "node:assert/strict";
import test from "node:test";

import { startFakeWebhook } from "./support/fake-webhook.js";
import { startGatewayProcess } from "./support/gateway-process.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { runT03ArtifactScan } from "./support/t03-observation.js";

const FIXTURE_URL = process.env.A2A_FASTMCP_FIXTURE_URL;
const PACKED_GATEWAY_CLI = process.env.A2A_PACKED_GATEWAY_CLI;
const TEST_KEY = "central-fixture-control";
const WEBHOOK_TOKEN = "90123456789abcde90123456789abcde90123456789abcde";
const EMAIL = "c01-packaged@fixture.invalid";
const USERNAME = "c01_packaged";
const CODE = "123456";
const MESSAGE_TEXT = "C01 packaged v2 message must remain in process memory 71c4.";
const RESET_V2_CLOCK = 1_788_000_000;

async function control<T>(
  baseUrl: string,
  path: string,
  body: object,
  failureMessage = `[C01-D01] Docker fixture control ${path} failed`,
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "X-A2A-Test-Key": TEST_KEY,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, failureMessage);
  assert.equal(
    response.headers.get("content-type"),
    "application/json",
    `[C01-D01] Docker fixture control ${path} returned the wrong media type`,
  );
  try {
    return (await response.json()) as T;
  } catch {
    assert.fail(`[C01-D01] Docker fixture control ${path} returned malformed JSON`);
  }
}

interface V2Inspection {
  now: number;
  agents: Array<{
    agent_id: string;
    verified: boolean;
    delivery_version: string;
    inbound_enabled: boolean;
  }>;
  messages: unknown[];
  replay_entries: number;
}

const RESET_V2_AGENTS = [
  {
    agent_id: "agent_fixture_0001",
    verified: true,
    delivery_version: "v2",
    inbound_enabled: true,
  },
  {
    agent_id: "agent_fixture_0002",
    verified: true,
    delivery_version: "v2",
    inbound_enabled: true,
  },
  {
    agent_id: "agent_fixture_0003",
    verified: true,
    delivery_version: "v2",
    inbound_enabled: true,
  },
  {
    agent_id: "agent_fixture_0004",
    verified: true,
    delivery_version: "v1",
    inbound_enabled: false,
  },
];

function assertResetV2State(value: V2Inspection): void {
  assert.equal(value.now, RESET_V2_CLOCK, "[C01-D01] fixture reset clock changed");
  assert.deepEqual(value.agents, RESET_V2_AGENTS, "[C01-D01] fixture reset state changed");
  assert.deepEqual(value.messages, [], "[C01-D01] fixture reset retained v2 messages");
  assert.equal(value.replay_entries, 0, "[C01-D01] fixture reset retained replay entries");
}

async function verificationCodeAfterRegistration(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("/__test/v2/verification-code", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "X-A2A-Test-Key": TEST_KEY,
    },
    body: JSON.stringify({ email: EMAIL }),
  });
  assert.equal(
    response.headers.get("content-type"),
    "application/json",
    "[C01-D01] verification-code control returned the wrong media type",
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    assert.fail("[C01-D01] verification-code control returned malformed JSON");
  }
  if (response.status === 404) {
    assert.deepEqual(
      body,
      { detail: "verification code not found" },
      "[C01-D01] verification-code control returned an unexpected missing-state body",
    );
    const inspection = await control<V2Inspection>(baseUrl, "/__test/v2/inspect", {});
    assertResetV2State(inspection);
    assert.fail(
      "[C01-D01:rest-registration] packaged gateway did not use the fixed REST registration route",
    );
  }
  assert.equal(response.status, 200, "[C01-D01] verification-code control failed");
  assert.deepEqual(body, { code: CODE }, "[C01-D01] verification-code control shape changed");
  return CODE;
}

test("C01-D01 packaged gateway completes fresh-install v2 through the independent Docker fixture", {
  skip: FIXTURE_URL === undefined || PACKED_GATEWAY_CLI === undefined,
}, async (t) => {
  assert.ok(FIXTURE_URL !== undefined);
  assert.ok(PACKED_GATEWAY_CLI !== undefined);
  assert.deepEqual(await control(FIXTURE_URL, "/__test/reset", {}), { status: "ok" });
  assertResetV2State(await control<V2Inspection>(FIXTURE_URL, "/__test/v2/inspect", {}));
  const webhook = await startFakeWebhook(t);
  const gateway = await startGatewayProcess(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: FIXTURE_URL,
    centralMcpUrl: new URL("/mcp", FIXTURE_URL).toString(),
    executable: PACKED_GATEWAY_CLI,
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN);
  await client.initialize();

  await client.callTool("register_agent", { email: EMAIL, username: USERNAME });
  const verificationCode = await verificationCodeAfterRegistration(FIXTURE_URL);
  const verified = await client.callTool("verify_email", { email: EMAIL, code: verificationCode });
  assert.equal(verified.verified, true);
  assert.equal(Object.hasOwn(verified, "token"), false);

  const injected = await control<{ message_id: string }>(FIXTURE_URL, "/__test/v2/messages", {
    sender_username: "fixture_sender",
    recipient_username: USERNAME,
    text: MESSAGE_TEXT,
  });
  const wake = await webhook.waitForWake();
  assert.equal(wake.headers["idempotency-key"], injected.message_id);
  const polled = await client.callTool("poll_messages", { timeout: 0 });
  assert.ok(Array.isArray(polled.messages));
  assert.equal((polled.messages[0] as { id?: unknown }).id, injected.message_id);
  await client.callTool("complete_message", {
    message_id: injected.message_id,
    outcome: "completed_without_reply",
    reason_code: "no_reply_required",
  });
  const acknowledged = await client.callTool("ack_message", {
    message_id: injected.message_id,
  });
  assert.deepEqual(acknowledged, { message_id: injected.message_id, status: "acked" });

  assert.deepEqual(await gateway.stop(), { code: 0, signal: null });
  await runT03ArtifactScan({
    artifactRoot: gateway.artifactRoot,
    captures: [
      { name: "packaged-gateway-stdout", value: gateway.stdout() },
      { name: "packaged-gateway-stderr", value: gateway.stderr() },
    ],
    markers: [
      { name: "webhook-token", value: WEBHOOK_TOKEN },
      { name: "registration-email", value: EMAIL },
      { name: "registration-username", value: USERNAME },
      { name: "verification-code", value: CODE },
      { name: "message-text", value: MESSAGE_TEXT },
    ],
  });
});
