import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStore, VersionedCredentialStore } from "../src/credential-store.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { startGatewayProcess } from "./support/gateway-process.js";
import { type McpTool, TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  registerPendingIdentity,
  seededCredentialV2,
  startT03GatewayScenario,
  T03_CODE,
  T03_EMAIL,
  T03_USERNAME,
  T03_WEBHOOK_TOKEN,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";

function toolByName(tools: readonly McpTool[], name: string): McpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `missing ${name} tool`);
  return tool;
}

function schemaProperties(tool: McpTool): Record<string, Record<string, unknown>> {
  const value = tool.inputSchema.properties;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, Record<string, unknown>>;
}

function schemaProperty(
  properties: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const property = properties[name];
  assert.ok(property !== undefined, `missing ${name} schema property`);
  return property;
}

test("T03-R01 full process owns the bootstrap catalog while central MCP is unavailable", async (t) => {
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  central.setMcpAvailable(false);
  const gateway = await startGatewayProcess(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();

  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "register_agent",
    "resend_verification",
    "verify_email",
  ]);
  assert.equal(central.calls.length, 0);
});

test("T03-R02 bootstrap schemas are gateway-owned, exact, and bounded", async (t) => {
  const { client } = await startT03GatewayScenario(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "register_agent",
    "resend_verification",
    "verify_email",
  ]);

  const registration = toolByName(tools, "register_agent");
  const registrationProperties = schemaProperties(registration);
  assert.equal(registration.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(registrationProperties).sort(), [
    "display_name",
    "email",
    "username",
  ]);
  assert.deepEqual([...(registration.inputSchema.required as string[])].sort(), [
    "email",
    "username",
  ]);
  const email = schemaProperty(registrationProperties, "email");
  const username = schemaProperty(registrationProperties, "username");
  const displayName = schemaProperty(registrationProperties, "display_name");
  assert.equal(email.type, "string");
  assert.equal(email.minLength, 3);
  assert.equal(email.maxLength, 254);
  assert.equal(email.pattern, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  assert.equal(username.minLength, 3);
  assert.equal(username.maxLength, 50);
  assert.equal(displayName.minLength, 1);
  assert.equal(displayName.maxLength, 128);

  const verification = toolByName(tools, "verify_email");
  const verificationProperties = schemaProperties(verification);
  assert.equal(verification.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(verificationProperties).sort(), ["code", "email"]);
  assert.deepEqual([...(verification.inputSchema.required as string[])].sort(), ["code", "email"]);
  const code = schemaProperty(verificationProperties, "code");
  const verificationEmail = schemaProperty(verificationProperties, "email");
  assert.equal(verificationEmail.type, "string");
  assert.equal(verificationEmail.minLength, 3);
  assert.equal(verificationEmail.maxLength, 254);
  assert.equal(verificationEmail.pattern, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  assert.equal(code.type, "string");
  assert.equal(code.minLength, 6);
  assert.equal(code.maxLength, 6);
  assert.equal(code.pattern, "^[A-Za-z0-9]{6}$");

  const resend = toolByName(tools, "resend_verification");
  const resendProperties = schemaProperties(resend);
  assert.equal(resend.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(resendProperties), ["email"]);
  assert.deepEqual(resend.inputSchema.required, ["email"]);
  const resendEmail = schemaProperty(resendProperties, "email");
  assert.equal(resendEmail.type, "string");
  assert.equal(resendEmail.minLength, 3);
  assert.equal(resendEmail.maxLength, 254);
  assert.equal(resendEmail.pattern, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
});

test("T03-R03 registration uses the fixed REST route without MCP or route fallback", async (t) => {
  const { central, client } = await startT03GatewayScenario(t);
  const localResult = await client.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
    display_name: "T03 gateway",
  });
  assert.ok(
    localResult.agent_id === "agent_fixture_0001" &&
      localResult.username === T03_USERNAME &&
      localResult.email === T03_EMAIL &&
      localResult.message === "Verification code sent.",
    "registration result did not use the selected REST response",
  );
  assert.equal(
    central.calls.some((call) => call.name === "register_agent"),
    false,
    "registration reached central MCP",
  );

  const repeat = await fetch(new URL("/api/register", central.apiUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      email: T03_EMAIL,
      username: T03_USERNAME,
      display_name: "T03 gateway",
    }),
  });
  assert.equal(repeat.status, 409, "the selected REST registration did not commit");
  await repeat.body?.cancel();
});

test("T03-R04 resend uses REST and returns the generic token-free projection", async (t) => {
  const { central, client } = await startT03GatewayScenario(t);
  await registerPendingIdentity(central);

  assert.deepEqual(await client.callTool("resend_verification", { email: T03_EMAIL }), {
    message: "Verification code resent.",
  });
  assert.equal(
    central.calls.some((call) => call.name === "resend_verification"),
    false,
    "resend reached central MCP",
  );
});

test("T03-R05 verification completes the nonce challenge and saves one bound version 2 record", async (t) => {
  const { central, client, credentials } = await startT03GatewayScenario(t);
  await registerPendingIdentity(central);

  const localResult = await client.callTool("verify_email", {
    email: T03_EMAIL,
    code: T03_CODE,
  });
  assert.deepEqual(localResult, {
    verified: true,
    agent_id: "agent_fixture_0001",
    username: T03_USERNAME,
    message: "Email verified successfully.",
  });
  assert.equal(JSON.stringify(localResult).includes("token"), false);
  assert.equal(credentials.saved.length, 1);
  const savedText = credentials.saved[0];
  assert.ok(savedText !== undefined);
  const saved = JSON.parse(savedText) as unknown;
  assert.ok(saved !== null && typeof saved === "object" && !Array.isArray(saved));
  assert.deepEqual(Object.keys(saved as Record<string, unknown>).sort(), [
    "access_token",
    "credential_version",
    "dpop_alg",
    "dpop_private_key_pkcs8",
    "token_type",
  ]);
  assert.equal((saved as Record<string, unknown>).credential_version, 2);
  assert.equal((saved as Record<string, unknown>).token_type, "DPoP");
  assert.equal((saved as Record<string, unknown>).dpop_alg, "ES256");
  assert.equal(
    central.calls.some((call) => call.name === "verify_email"),
    false,
    "verification reached central MCP",
  );
});

test("T03-R06 persistence failure leaves the gateway unenrolled after valid issuance", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  await registerPendingIdentity(central);
  const webhook = await startFakeWebhook(t);
  let saveAttempted = false;
  const failingStore: CredentialStore & VersionedCredentialStore = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error("version 2 used the legacy credential store API");
    },
    async loadCredential() {
      return undefined;
    },
    async saveCredential(credential) {
      assert.equal(credential.version, 2);
      saveAttempted = true;
      throw new Error("injected credential publication failure");
    },
  };
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: failingStore,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();

  await assert.rejects(client.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE }));
  assert.equal(saveAttempted, true);
  assert.equal(central.pollCount(), 0);
  assert.deepEqual((await client.listTools()).map((tool) => tool.name).sort(), [
    "register_agent",
    "resend_verification",
    "verify_email",
  ]);
});

test("T03-R07 restart loads the bound key and uses fresh DPoP on repeated central MCP calls", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const credential = seededCredentialV2(central, "fixture_sender");
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore(JSON.stringify(credential));
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();

  const tools = await client.listTools();
  const actionTypes = toolByName(tools, "list_action_types");
  assert.equal(Object.hasOwn(schemaProperties(actionTypes), "token"), false);
  assert.deepEqual(await client.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  assert.deepEqual(await client.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  assert.equal(
    central.calls.some((call) => Object.hasOwn(call.args, "token")),
    false,
    "a central MCP argument carried a token",
  );
});
