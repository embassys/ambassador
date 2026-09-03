import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentCapability,
  PRODUCTION_AGENT_CAPABILITIES,
  resolveAgentCapability,
} from "../src/agent-capabilities.js";

test("records all reviewed production agent contracts exactly", () => {
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
    {
      kind: "codex",
      displayName: "Codex",
      enabled: true,
      aliases: [
        { name: "codex-mcp-client", version: "0.149.0" },
        { name: "codex-mcp-client", version: "0.152.1" },
      ],
      modes: ["direct"],
      direct: {
        command: "codex-acp",
        args: [],
        agentInfo: { name: "@agentclientprotocol/codex-acp", versions: ["1.8.0"] },
        mcp: "session",
        environment: [
          "CODEX_API_KEY",
          "HOME",
          "LANG",
          "LC_ALL",
          "NODE_EXTRA_CA_CERTS",
          "OPENAI_API_KEY",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "TMPDIR",
          "USERPROFILE",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_RUNTIME_DIR",
          "XDG_STATE_HOME",
        ],
      },
      qualificationCases: ["codex-direct"],
    },
    {
      kind: "claude",
      displayName: "Claude Code",
      enabled: true,
      aliases: [
        { name: "claude-code", version: "2.1.257" },
        { name: "claude-code", version: "2.1.258" },
      ],
      modes: ["direct"],
      direct: {
        command: "claude-agent-acp",
        args: [],
        agentInfo: { name: "@agentclientprotocol/claude-agent-acp", versions: ["0.73.0"] },
        mcp: "session",
        environment: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
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
      qualificationCases: ["claude-direct"],
    },
    {
      kind: "gemini",
      displayName: "Gemini CLI",
      enabled: true,
      aliases: [{ name: "gemini-cli-mcp-client", version: "0.58.0" }],
      modes: ["direct"],
      direct: {
        command: "gemini",
        args: ["--acp"],
        agentInfo: { name: "gemini-cli", versions: ["0.58.0"] },
        mcp: "session",
        environment: [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_CLOUD_LOCATION",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_GENAI_USE_VERTEXAI",
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
      qualificationCases: ["gemini-direct"],
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
  for (const [name, version, kind] of [
    ["codex-mcp-client", "0.149.0", "codex"],
    ["codex-mcp-client", "0.152.1", "codex"],
    ["claude-code", "2.1.257", "claude"],
    ["claude-code", "2.1.258", "claude"],
    ["gemini-cli-mcp-client", "0.58.0", "gemini"],
  ] as const) {
    const result = resolveAgentCapability({ name, version });
    assert.equal(result.status, "matched");
    assert.equal(result.status === "matched" ? result.profile.kind : undefined, kind);
  }
  assert.equal(
    resolveAgentCapability({ name: "codex-mcp-client", version: "0.152.2" }).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "claude-code", version: "2.1.256" }).status,
    "unsupported",
  );
  assert.equal(
    resolveAgentCapability({ name: "gemini-cli-mcp-client", version: "0.58.1" }).status,
    "unsupported",
  );

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
