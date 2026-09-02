import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentCapability,
  PRODUCTION_AGENT_CAPABILITIES,
  resolveAgentCapability,
} from "../src/agent-capabilities.js";

test("records the reviewed OpenClaw and Hermes contracts exactly", () => {
  assert.deepEqual(PRODUCTION_AGENT_CAPABILITIES, [
    {
      kind: "openclaw",
      displayName: "OpenClaw",
      enabled: true,
      aliases: [{ name: "openclaw-bundle-mcp", version: "0.0.0" }],
      modes: ["direct", "webhook"],
      direct: {
        command: "openclaw",
        args: ["acp"],
        agentInfo: { name: "openclaw-acp", versions: ["2026.8.1"] },
        mcp: "provider_config",
        environment: [
          "HOME",
          "LANG",
          "LC_ALL",
          "NODE_EXTRA_CA_CERTS",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "TMPDIR",
          "USERPROFILE",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ],
      },
      qualificationCases: ["openclaw-webhook", "openclaw-direct"],
    },
    {
      kind: "hermes",
      displayName: "Hermes",
      enabled: true,
      aliases: [{ name: "mcp", version: "0.1.0" }],
      modes: ["direct", "webhook"],
      direct: {
        command: "hermes-acp",
        args: [],
        agentInfo: { name: "hermes-agent", versions: ["0.21.0"] },
        mcp: "session",
        environment: [
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "TMPDIR",
          "USERPROFILE",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ],
      },
      qualificationCases: ["hermes-webhook", "hermes-direct"],
    },
  ]);
});

test("matches exact aliases and rejects unknown, ambiguous, disabled, and incomplete profiles", () => {
  const matched = resolveAgentCapability({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.equal(matched.status, "matched");
  assert.equal(matched.status === "matched" ? matched.profile.kind : undefined, "openclaw");
  assert.equal(
    resolveAgentCapability({ name: "OpenClaw-bundle-mcp", version: "0.0.0" }).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "openclaw-bundle-mcp", version: "0.0.1" }).status,
    "unsupported",
  );
  assert.equal(resolveAgentCapability({ name: "codex", version: "1" }).status, "unsupported");

  const base = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(base);
  const directOnly: AgentCapability = {
    ...base,
    kind: "fixture-direct",
    displayName: "Fixture Direct",
    aliases: [{ name: "fixture-direct", version: "1" }],
    modes: ["direct"],
    qualificationCases: ["fixture-direct"],
  };
  assert.deepEqual(resolveAgentCapability({ name: "fixture-direct", version: "1" }, [directOnly]), {
    status: "matched",
    profile: directOnly,
  });

  const disabled = { ...directOnly, enabled: false };
  assert.equal(
    resolveAgentCapability({ name: "fixture-direct", version: "1" }, [disabled]).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "fixture-direct", version: "1" }, [
      directOnly,
      { ...directOnly, kind: "duplicate" },
    ]).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "fixture-direct", version: "1" }, [
      { ...directOnly, direct: undefined } as unknown as AgentCapability,
    ]).status,
    "unsupported",
  );
});

test("rejects oversized or decorated client metadata without fuzzy matching", () => {
  assert.equal(
    resolveAgentCapability({ name: "x".repeat(129), version: "1" }).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "prefix-openclaw-bundle-mcp", version: "0.0.0" }).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "openclaw-bundle-mcp ", version: "0.0.0" }).status,
    "unsupported",
  );
});
