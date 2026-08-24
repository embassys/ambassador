import assert from "node:assert/strict";
import { test } from "node:test";

import { createWakeAdapter } from "../src/adapters/factory.js";
import { GenericWebhookAdapter } from "../src/adapters/generic.js";
import { HermesWebhookAdapter } from "../src/adapters/hermes.js";
import { OpenClawWebhookAdapter } from "../src/adapters/openclaw.js";
import type { AgentConfig } from "../src/config.js";

const agents = [
  {
    binding_id: "binding_generic",
    adapter: {
      type: "generic",
      url: "http://127.0.0.1:9001/wake",
      secret: { source: "env", name: "GENERIC_SECRET" },
    },
  },
  {
    binding_id: "binding_hermes",
    adapter: {
      type: "hermes",
      url: "http://127.0.0.1:9002/webhooks/a2a",
      secret: { source: "env", name: "HERMES_SECRET" },
    },
  },
  {
    binding_id: "binding_openclaw",
    adapter: {
      type: "openclaw",
      url: "http://127.0.0.1:9003/hooks/agent",
      agent_id: "agent_local",
      token: { source: "env", name: "OPENCLAW_TOKEN" },
    },
  },
] satisfies AgentConfig[];

test("creates each configured adapter with environment-referenced credentials", () => {
  const options = {
    env: {
      GENERIC_SECRET: "generic-secret",
      HERMES_SECRET: "hermes-secret",
      OPENCLAW_TOKEN: "openclaw-token",
    },
  };

  assert.ok(createWakeAdapter(agents[0] as AgentConfig, options) instanceof GenericWebhookAdapter);
  assert.ok(createWakeAdapter(agents[1] as AgentConfig, options) instanceof HermesWebhookAdapter);
  assert.ok(createWakeAdapter(agents[2] as AgentConfig, options) instanceof OpenClawWebhookAdapter);
});

test("missing credentials fail without exposing unrelated environment values", () => {
  const unrelated = "must-not-appear";
  assert.throws(
    () => createWakeAdapter(agents[0] as AgentConfig, { env: { OTHER_SECRET: unrelated } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.name, "NotImplementedError");
      assert.equal(`${error.message}${JSON.stringify(error)}`.includes(unrelated), false);
      return true;
    },
  );
});
