import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { type AgentCapability, PRODUCTION_AGENT_CAPABILITIES } from "../src/agent-capabilities.js";
import { DeliveryProfileStore } from "../src/delivery-profile.js";
import { GuidedRegistration, GuidedRegistrationError } from "../src/guided-registration.js";

const SECRET = "0123456789abcdef0123456789abcdef";

async function fixture(t: TestContext, registry = PRODUCTION_AGENT_CAPABILITIES) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const registration = new GuidedRegistration({
    registry,
    profileStore: new DeliveryProfileStore(join(root, "delivery-profile.json")),
    workingDirectory: root,
    environment: { EMBASSYS_WEBHOOK_SECRET: SECRET },
    registerCentral: async (arguments_) => {
      calls.push(arguments_);
      return {
        agent_id: "agent-1",
        email: String(arguments_.email),
        message: "Verification sent",
      };
    },
  });
  return { root, calls, registration };
}

test("OpenClaw and Hermes ask for delivery with direct as the default", async (t) => {
  for (const clientInfo of [
    { name: "openclaw-bundle-mcp", version: "0.0.0" },
    { name: "mcp", version: "0.1.0" },
  ]) {
    await t.test(clientInfo.name, async (t) => {
      const { calls, registration } = await fixture(t);
      const result = await registration.register(
        { email: "agent@example.test" },
        clientInfo,
        new AbortController().signal,
      );
      const label = clientInfo.name === "mcp" ? "Hermes" : "OpenClaw";
      assert.deepEqual(result, {
        status: "input_required",
        prompt: "How should incoming requests reach this agent?",
        required: ["delivery"],
        default: "direct",
        choices: [
          { value: "direct", label: `Send directly to this ${label} agent` },
          { value: "webhook", label: "Send to a webhook" },
        ],
      });
      assert.deepEqual(calls, []);
    });
  }
});

test("persists the derived direct or webhook profile before central registration", async (t) => {
  const direct = await fixture(t);
  const directResult = await direct.registration.register(
    { email: "direct@example.test", delivery: { mode: "direct" } },
    { name: "openclaw-bundle-mcp", version: "0.0.0" },
    new AbortController().signal,
  );
  assert.equal(directResult.agent_id, "agent-1");
  assert.deepEqual(direct.calls, [{ email: "direct@example.test" }]);

  const webhook = await fixture(t);
  const webhookResult = await webhook.registration.register(
    {
      email: "webhook@example.test",
      display_name: "Webhook agent",
      delivery: {
        mode: "webhook",
        url: "https://agent.example.test/embassys",
        secret_env: "EMBASSYS_WEBHOOK_SECRET",
      },
    },
    { name: "mcp", version: "0.1.0" },
    new AbortController().signal,
  );
  assert.equal(webhookResult.agent_id, "agent-1");
  assert.deepEqual(webhook.calls, [
    { email: "webhook@example.test", display_name: "Webhook agent" },
  ]);
});

test("a direct-only profile registers without asking a delivery question", async (t) => {
  const base = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(base);
  const profile: AgentCapability = {
    ...base,
    kind: "fixture-direct",
    displayName: "Fixture direct",
    aliases: [{ name: "fixture-direct", version: "1" }],
    modes: ["direct"],
    qualificationCases: ["fixture-direct"],
  };
  const { calls, registration } = await fixture(t, [profile]);
  const result = await registration.register(
    { email: "direct-only@example.test" },
    { name: "fixture-direct", version: "1" },
    new AbortController().signal,
  );
  assert.equal(result.agent_id, "agent-1");
  assert.deepEqual(calls, [{ email: "direct-only@example.test" }]);
});

test("unsupported metadata and model-supplied process fields fail before state or central", async (t) => {
  for (const value of [
    {
      arguments: {
        email: "unknown@example.test",
        delivery: {
          mode: "webhook",
          url: "https://agent.example.test/embassys",
          secret_env: "EMBASSYS_WEBHOOK_SECRET",
        },
      },
      clientInfo: { name: "unknown", version: "1" },
      status: "unsupported_agent",
    },
    {
      arguments: { email: "bad@example.test", agent: "openclaw" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "0.0.0" },
      status: "error",
    },
    {
      arguments: { email: "bad@example.test", command: "openclaw" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "0.0.0" },
      status: "error",
    },
    {
      arguments: { email: "bad@example.test", working_directory: "/tmp" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "0.0.0" },
      status: "error",
    },
  ]) {
    await t.test(value.status, async (t) => {
      const { calls, registration } = await fixture(t);
      if (value.status === "unsupported_agent") {
        assert.deepEqual(
          await registration.register(
            value.arguments,
            value.clientInfo,
            new AbortController().signal,
          ),
          {
            status: "unsupported_agent",
            message: "This MCP client is not supported by this Ambassador version.",
          },
        );
      } else {
        await assert.rejects(
          registration.register(value.arguments, value.clientInfo, new AbortController().signal),
          (error: unknown) =>
            error instanceof GuidedRegistrationError && error.code === "invalid_arguments",
        );
      }
      assert.deepEqual(calls, []);
    });
  }
});
