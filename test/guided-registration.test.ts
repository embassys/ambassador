import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { type AgentCapability, PRODUCTION_AGENT_CAPABILITIES } from "../src/agent-capabilities.js";
import { DeliveryProfileStore } from "../src/delivery-profile.js";
import { GuidedRegistration, GuidedRegistrationError } from "../src/guided-registration.js";
import type { WebhookSecretStore } from "../src/webhook-secret-store.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

async function fixture(
  t: TestContext,
  registry = PRODUCTION_AGENT_CAPABILITIES,
  webhookSecret: string | undefined = SECRET,
) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const webhookSecretStore: WebhookSecretStore = {
    async load() {
      return webhookSecret;
    },
    async createOrLoad() {
      return webhookSecret ?? SECRET;
    },
  };
  const registration = new GuidedRegistration({
    registry,
    profileStore: new DeliveryProfileStore(join(root, "delivery-profile.json")),
    webhookSecretStore,
    workingDirectory: root,
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
  for (const { clientInfo, label } of [
    { clientInfo: { name: "openclaw-bundle-mcp", version: "qualification" }, label: "OpenClaw" },
    { clientInfo: { name: "mcp", version: "qualification" }, label: "Hermes" },
  ]) {
    await t.test(`${clientInfo.name}-${clientInfo.version}`, async (t) => {
      const { calls, registration } = await fixture(t);
      const result = await registration.register(
        { email: "agent@example.test" },
        clientInfo,
        new AbortController().signal,
      );
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

test("webhook selection explains secret setup before creating local or central state", async (t) => {
  const { calls, registration } = await fixture(t, PRODUCTION_AGENT_CAPABILITIES, undefined);
  const result = await registration.register(
    {
      email: "webhook@example.test",
      delivery: { mode: "webhook" },
    },
    { name: "mcp", version: "qualification" },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    status: "input_required",
    prompt:
      "Run `ambassador webhook-secret`, configure the displayed secret in Hermes, then retry with the receiver URL.",
    required: ["delivery.url"],
    command: "ambassador webhook-secret",
  });
  assert.deepEqual(calls, []);
});

test("OpenClaw webhook selection points to its native hook without a plugin", async (t) => {
  const { calls, registration } = await fixture(t, PRODUCTION_AGENT_CAPABILITIES, undefined);
  const result = await registration.register(
    {
      email: "webhook@example.test",
      delivery: { mode: "webhook" },
    },
    { name: "openclaw-bundle-mcp", version: "qualification" },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    status: "input_required",
    prompt:
      "Run `ambassador webhook-secret`, set the displayed value as OpenClaw `hooks.token`, enable hooks for agent `main`, restart OpenClaw, then retry with its `/hooks/agent` URL.",
    required: ["delivery.url"],
    command: "ambassador webhook-secret",
  });
  assert.deepEqual(calls, []);
});

test("Codex, Claude Code, and Gemini CLI register directly without a delivery question", async (t) => {
  for (const clientInfo of [
    { name: "codex-mcp-client", version: "qualification" },
    { name: "claude-code", version: "qualification" },
    { name: "gemini-cli-mcp-client", version: "qualification" },
  ]) {
    await t.test(`${clientInfo.name}-${clientInfo.version}`, async (t) => {
      const { calls, registration } = await fixture(t);
      const result = await registration.register(
        { email: "direct@example.test" },
        clientInfo,
        new AbortController().signal,
      );
      assert.equal(result.agent_id, "agent-1");
      assert.deepEqual(calls, [{ email: "direct@example.test" }]);
    });
  }
});

test("direct-only production profiles reject webhook input before state or central", async (t) => {
  for (const clientInfo of [
    { name: "codex-mcp-client", version: "qualification" },
    { name: "claude-code", version: "qualification" },
    { name: "gemini-cli-mcp-client", version: "qualification" },
  ]) {
    await t.test(clientInfo.name, async (t) => {
      const { calls, registration } = await fixture(t);
      await assert.rejects(
        registration.register(
          {
            email: "webhook@example.test",
            delivery: {
              mode: "webhook",
              url: "https://agent.example.test/embassys",
            },
          },
          clientInfo,
          new AbortController().signal,
        ),
        (error: unknown) =>
          error instanceof GuidedRegistrationError && error.code === "invalid_arguments",
      );
      assert.deepEqual(calls, []);
    });
  }
});

test("persists the derived direct or webhook profile before central registration", async (t) => {
  const direct = await fixture(t);
  const directResult = await direct.registration.register(
    { email: "direct@example.test", delivery: { mode: "direct" } },
    { name: "openclaw-bundle-mcp", version: "qualification" },
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
      },
    },
    { name: "mcp", version: "qualification" },
    new AbortController().signal,
  );
  assert.equal(webhookResult.agent_id, "agent-1");
  assert.deepEqual(webhook.calls, [
    { email: "webhook@example.test", display_name: "Webhook agent" },
  ]);

  for (const clientInfo of [
    { name: "codex-mcp-client", version: "qualification" },
    { name: "claude-code", version: "qualification" },
    { name: "gemini-cli-mcp-client", version: "qualification" },
  ]) {
    await t.test(clientInfo.name, async (t) => {
      const selected = await fixture(t);
      const result = await selected.registration.register(
        { email: `${clientInfo.name}@example.test`, delivery: { mode: "direct" } },
        clientInfo,
        new AbortController().signal,
      );
      assert.equal(result.agent_id, "agent-1");
      assert.equal(selected.calls.length, 1);
    });
  }
});

test("a direct-only profile registers without asking a delivery question", async (t) => {
  const base = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(base);
  const { webhook: _webhook, ...baseWithoutWebhook } = base;
  const profile: AgentCapability = {
    ...baseWithoutWebhook,
    kind: "fixture-direct",
    displayName: "Fixture direct",
    aliases: ["fixture-direct"],
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
        },
      },
      clientInfo: { name: "unknown", version: "1" },
      status: "unsupported_agent",
    },
    {
      arguments: { email: "bad@example.test", agent: "openclaw" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "qualification" },
      status: "error",
    },
    {
      arguments: { email: "bad@example.test", command: "openclaw" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "qualification" },
      status: "error",
    },
    {
      arguments: { email: "bad@example.test", working_directory: "/tmp" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "qualification" },
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
