import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { runSecondGateway, startGatewayProcess } from "./support/gateway-process.js";
import { McpCallError, type McpTool, TestMcpClient } from "./support/mcp-client.js";
import { rawPost } from "./support/raw-http.js";
import { startGateway } from "./support/start-gateway.js";

const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const EMAIL = "fixture-agent@example.test";
const CODE = "246810";
const MESSAGE_ID = "message_fixture_01";
const MESSAGE_CONTENT = "fixture message body must stay out of gateway state";

function propertyNames(tool: McpTool): string[] {
  const properties = tool.inputSchema.properties;
  assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
  return Object.keys(properties as Record<string, unknown>).sort();
}

function assertNoCredentialSelector(tool: McpTool): void {
  const forbidden = ["agent_id", "credential", "credential_id", "jwt", "token"];
  const properties = propertyNames(tool);
  const required = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as unknown[])
    : [];
  for (const name of forbidden) {
    assert.ok(!properties.includes(name), `${tool.name} exposes a credential selector`);
    assert.ok(!required.includes(name), `${tool.name} requires a credential selector`);
  }
}

async function scanFiles(root: string, markers: string[]): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const bytes = await readFile(join(entry.parentPath, entry.name));
    for (const marker of markers) {
      assert.ok(!bytes.includes(Buffer.from(marker)), `${entry.name} contains forbidden plaintext`);
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("timed out waiting for expected state transition");
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

  const wrongHost = await rawPost(
    gateway.endpoint,
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${WEBHOOK_TOKEN}`,
      "content-type": "application/json",
      host: "localhost:8787",
    },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  );
  assert.equal(wrongHost.status, 421);

  const oversizedMarker = "oversized-body-marker";
  const oversized = await rawPost(
    gateway.endpoint,
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${WEBHOOK_TOKEN}`,
      "content-type": "application/json",
      host: "127.0.0.1:8787",
    },
    `${oversizedMarker}${"x".repeat(1_048_576)}`,
  );
  assert.equal(oversized.status, 413);
  assert.ok(!oversized.body.includes(oversizedMarker));

  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await client.initialize();
  assert.deepEqual(client.serverCapabilities.tools, { listChanged: true });
  const bootstrapTools = await client.listTools();
  assert.deepEqual(bootstrapTools.map((tool) => tool.name).sort(), [
    "register_agent",
    "resend_verification",
    "verify_email",
  ]);
  for (const tool of bootstrapTools) {
    assertNoCredentialSelector(tool);
  }

  const resendCallsBefore = central.calls.length;
  await assert.rejects(
    client.callTool("resend_verification", { email: EMAIL }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(central.calls.length, resendCallsBefore + 1);
  assert.equal(central.calls.at(-1)?.name, "resend_verification");

  await delay(100);
  assert.equal(central.pollCount(), 0, "central polling started before verification");

  const registration = await client.callTool("register_agent", {
    username: "fixture-agent",
    email: EMAIL,
    display_name: "Fixture Agent",
  });
  assert.ok(registration.agent_id === "agent_fixture");
  assert.ok(!Object.hasOwn(registration, "token"));

  const toolListChanged = client.waitForNotification("notifications/tools/list_changed");
  void toolListChanged.catch(() => undefined);
  const verification = await client.callTool("verify_email", { email: EMAIL, code: CODE });
  assert.ok(!JSON.stringify(verification).includes(central.jwt));
  assert.deepEqual(Object.keys(verification).sort(), [
    "agent_id",
    "message",
    "username",
    "verified",
  ]);
  assert.equal(verification.verified, true);
  assert.ok(verification.agent_id === "agent_fixture");
  assert.equal(verification.username, "fixture-agent");
  assert.equal(verification.message, "Email verified successfully.");
  await toolListChanged;
  for (const call of central.calls.filter((item) =>
    ["register_agent", "resend_verification", "verify_email"].includes(item.name),
  )) {
    assert.ok(!Object.hasOwn(call.args, "token"));
  }

  const wake = await webhook.waitForWake();
  assert.equal(wake.method, "POST");
  assert.equal(wake.path, "/hooks/agent");
  assert.equal(wake.contentType, "application/json");
  assert.ok(wake.headers.authorization === `Bearer ${WEBHOOK_TOKEN}`);
  assert.equal(wake.headers["idempotency-key"], MESSAGE_ID);
  assert.deepEqual(Object.keys(wake.body).sort(), ["deliver", "message", "name", "wakeMode"]);
  assert.equal(wake.body.name, "A2A Gateway");
  assert.equal(wake.body.deliver, false);
  assert.equal(wake.body.wakeMode, "now");
  assert.equal(
    wake.body.message,
    `A2A message ${MESSAGE_ID} is ready. Use the A2A MCP tools to retrieve and process it.`,
  );
  const serializedWake = JSON.stringify(wake.body);
  assert.ok(!serializedWake.includes(central.jwt));
  assert.ok(!serializedWake.includes(WEBHOOK_TOKEN));
  await waitFor(() => central.messageState(MESSAGE_ID).notificationAcknowledged);
  assert.equal(central.messageState(MESSAGE_ID).contentAcknowledged, false);

  const authenticatedTools = await client.listTools();
  assert.deepEqual(authenticatedTools.map((tool) => tool.name).sort(), [
    "ack_message",
    "poll_messages",
  ]);
  for (const tool of authenticatedTools) {
    assertNoCredentialSelector(tool);
  }

  for (const selector of ["token", "jwt", "agent_id"]) {
    const callsBefore = central.calls.length;
    await assert.rejects(
      client.callTool("poll_messages", { timeout: 0, [selector]: "caller-controlled" }),
      (error: unknown) => error instanceof McpCallError,
    );
    assert.equal(central.calls.length, callsBefore, `${selector} reached the central fixture`);
  }

  const polled = await client.callTool("poll_messages", { timeout: 0 });
  assert.ok(!JSON.stringify(polled).includes(central.jwt));
  const messages = polled.messages;
  assert.ok(Array.isArray(messages) && messages.length === 1);
  const message = messages[0] as Record<string, unknown>;
  assert.equal(message.id, MESSAGE_ID);
  assert.ok(message.content === MESSAGE_CONTENT);
  await client.callTool("ack_message", { message_id: MESSAGE_ID });
  assert.equal(central.messageState(MESSAGE_ID).contentAcknowledged, true);

  const callsBeforeReplacement = central.calls.length;
  await assert.rejects(
    client.callTool("verify_email", { email: "replacement@example.test", code: CODE }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(central.calls.length, callsBeforeReplacement);

  const authenticatedCalls = central.calls.filter((call) =>
    ["poll_messages", "ack_message"].includes(call.name),
  );
  assert.equal(authenticatedCalls.length, 2);
  for (const call of authenticatedCalls) {
    assert.ok(call.args.token === central.jwt);
    const expectedKeys =
      call.name === "poll_messages" ? ["timeout", "token"] : ["message_id", "token"];
    assert.deepEqual(Object.keys(call.args).sort(), expectedKeys);
  }

  assert.equal(await gateway.stop(), 0);
  const restarted = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    artifactRoot: gateway.artifactRoot,
  });
  const restartedClient = new TestMcpClient(restarted.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await restartedClient.initialize();
  assert.deepEqual((await restartedClient.listTools()).map((tool) => tool.name).sort(), [
    "ack_message",
    "poll_messages",
  ]);
  assert.equal(await restarted.stop(), 0);
  const forbidden = [
    WEBHOOK_TOKEN,
    central.jwt,
    EMAIL,
    CODE,
    MESSAGE_CONTENT,
    "fixture-agent",
    "Fixture Agent",
    "agent_fixture",
    "Verification code sent.",
  ];
  await scanFiles(gateway.artifactRoot, forbidden);
  for (const marker of forbidden) {
    assert.ok(!gateway.stdout().includes(marker));
    assert.ok(!gateway.stderr().includes(marker));
    assert.ok(!restarted.stdout().includes(marker));
    assert.ok(!restarted.stderr().includes(marker));
  }
});

test("malformed verification output never activates polling or reaches the local result", async (t) => {
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const secondToken = "second-central-token-must-not-escape";
  central.setVerificationResult({
    agent_id: "agent_fixture",
    username: "fixture-agent",
    token: central.jwt,
    access_token: secondToken,
    message: "Email verified successfully.",
  });
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt, secondToken],
  });
  await client.initialize();

  await assert.rejects(
    client.callTool("verify_email", { email: EMAIL, code: CODE }),
    (error: unknown) => error instanceof McpCallError,
  );
  await delay(100);
  assert.equal(central.pollCount(), 0);
  assert.equal(await gateway.stop(), 0);
  await scanFiles(gateway.artifactRoot, [central.jwt, secondToken, EMAIL, CODE]);
});

test("credential persistence failure returns no JWT and leaves polling dormant", async (t) => {
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  let saveCalls = 0;
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: {
      async load() {
        return undefined;
      },
      async save(token) {
        saveCalls += 1;
        assert.ok(token === central.jwt);
        throw new Error("injected credential-store failure");
      },
    },
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await client.initialize();

  await assert.rejects(
    client.callTool("verify_email", { email: EMAIL, code: CODE }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(saveCalls, 1);
  await delay(100);
  assert.equal(central.pollCount(), 0);
  assert.equal(await gateway.stop(), 0);
  await scanFiles(gateway.artifactRoot, [central.jwt, EMAIL, CODE]);
});

test("a failed webhook attempt retries the same opaque ID", async (t) => {
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t, { statuses: [503, 200] });
  central.injectMessage(MESSAGE_ID, MESSAGE_CONTENT);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await client.initialize();
  await client.callTool("verify_email", { email: EMAIL, code: CODE });

  const first = await webhook.waitForWake();
  const second = await webhook.waitForWake();
  assert.equal(first.headers["idempotency-key"], MESSAGE_ID);
  assert.equal(second.headers["idempotency-key"], MESSAGE_ID);
  assert.equal(first.body.message, second.body.message);
  assert.deepEqual(Object.keys(first.body).sort(), Object.keys(second.body).sort());

  await client.callTool("ack_message", { message_id: MESSAGE_ID });
  assert.equal(await gateway.stop(), 0);
});

test("the packaged CLI stays foreground, owns one instance, and stops on SIGTERM", async (t) => {
  const webhook = await startFakeWebhook(t);
  const token = "fedcba9876543210fedcba9876543210fedcba9876543210";
  const gateway = await startGatewayProcess(t, { webhookUrl: webhook.url, webhookToken: token });
  assert.equal(gateway.endpoint, "http://127.0.0.1:8787/mcp");

  const contender = await runSecondGateway(gateway.artifactRoot, webhook.url);
  assert.notEqual(contender.code, 0);
  assert.ok(!contender.stdout.includes(token));
  assert.ok(!contender.stderr.includes(token));
  assert.ok(!contender.stdout.includes("A2A_WEBHOOK_TOKEN"));
  assert.ok(!contender.stderr.includes("A2A_WEBHOOK_TOKEN"));

  const stopped = await gateway.stop();
  assert.equal(stopped.code, 0);
  assert.equal(stopped.signal, null);
  assert.ok(!gateway.stdout().includes(token));
  assert.ok(!gateway.stderr().includes(token));
});
