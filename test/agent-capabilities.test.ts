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
      aliases: ["openclaw-bundle-mcp"],
      modes: ["direct", "webhook"],
      webhook: {
        format: "openclaw-agent",
        agentId: "main",
      },
      direct: {
        command: "openclaw",
        args: ["acp"],
        agentInfo: { name: "openclaw-acp" },
        mcp: "provider_config",
        environment: [
          "APPDATA",
          "HOME",
          "LANG",
          "LC_ALL",
          "LOCALAPPDATA",
          "NODE_EXTRA_CA_CERTS",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "SystemRoot",
          "TEMP",
          "TMP",
          "TMPDIR",
          "USERPROFILE",
          "WINDIR",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ],
        windowsNodePackage: {
          packageName: "openclaw",
          binName: "openclaw",
          entrypoint: "openclaw.mjs",
        },
      },
      qualificationCases: ["openclaw-webhook", "openclaw-direct"],
    },
    {
      kind: "hermes",
      displayName: "Hermes",
      enabled: true,
      aliases: ["mcp"],
      modes: ["direct", "webhook"],
      webhook: {
        format: "ambassador-hmac-v2",
      },
      direct: {
        command: "hermes-acp",
        args: [],
        agentInfo: { name: "hermes-agent" },
        mcp: "session",
        environment: [
          "APPDATA",
          "HOME",
          "LANG",
          "LC_ALL",
          "LOCALAPPDATA",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "SystemRoot",
          "TEMP",
          "TMP",
          "TMPDIR",
          "USERPROFILE",
          "WINDIR",
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
      aliases: ["codex-mcp-client"],
      modes: ["direct"],
      direct: {
        command: "codex-acp",
        args: [],
        agentInfo: { name: "@agentclientprotocol/codex-acp" },
        mcp: "session",
        environment: [
          "APPDATA",
          "CODEX_API_KEY",
          "HOME",
          "LANG",
          "LC_ALL",
          "LOCALAPPDATA",
          "NODE_EXTRA_CA_CERTS",
          "OPENAI_API_KEY",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "SystemRoot",
          "TEMP",
          "TMP",
          "TMPDIR",
          "USERPROFILE",
          "WINDIR",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_RUNTIME_DIR",
          "XDG_STATE_HOME",
        ],
        bundledNodePackage: {
          packageName: "@agentclientprotocol/codex-acp",
          binName: "codex-acp",
          entrypoint: "dist/index.js",
        },
      },
      qualificationCases: ["codex-direct"],
    },
    {
      kind: "claude",
      displayName: "Claude Code",
      enabled: true,
      aliases: ["claude-code"],
      modes: ["direct"],
      direct: {
        command: "claude-agent-acp",
        args: [],
        agentInfo: { name: "@agentclientprotocol/claude-agent-acp" },
        mcp: "session",
        environment: [
          "APPDATA",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "HOME",
          "LANG",
          "LC_ALL",
          "LOCALAPPDATA",
          "NODE_EXTRA_CA_CERTS",
          "PATH",
          "SSL_CERT_DIR",
          "SSL_CERT_FILE",
          "SystemRoot",
          "TEMP",
          "TMP",
          "TMPDIR",
          "USERPROFILE",
          "WINDIR",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ],
        bundledNodePackage: {
          packageName: "@agentclientprotocol/claude-agent-acp",
          binName: "claude-agent-acp",
          entrypoint: "dist/index.js",
        },
      },
      qualificationCases: ["claude-direct"],
    },
  ]);
});

test("Hermes ACP support fixes the agent name without pinning a version", () => {
  const hermes = PRODUCTION_AGENT_CAPABILITIES.find((profile) => profile.kind === "hermes");
  assert.deepEqual(hermes?.direct?.agentInfo, { name: "hermes-agent" });
});

test("matches exact client names and rejects unknown, ambiguous, disabled, and incomplete profiles", () => {
  const matched = resolveAgentCapability({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.equal(matched.status, "matched");
  assert.equal(matched.status === "matched" ? matched.profile.kind : undefined, "openclaw");
  assert.equal(
    resolveAgentCapability({ name: "OpenClaw-bundle-mcp", version: "0.0.0" }).status,
    "unsupported",
  );
  assert.equal(resolveAgentCapability({ name: "codex", version: "1" }).status, "unsupported");
  for (const [name, version, kind] of [
    ["codex-mcp-client", "0.149.0", "codex"],
    ["codex-mcp-client", "0.152.1", "codex"],
    ["claude-code", "2.1.257", "claude"],
    ["claude-code", "2.1.258", "claude"],
  ] as const) {
    const result = resolveAgentCapability({ name, version });
    assert.equal(result.status, "matched");
    assert.equal(result.status === "matched" ? result.profile.kind : undefined, kind);
  }
  for (const name of ["gemini-cli-mcp-client", "antigravity-client"]) {
    assert.equal(resolveAgentCapability({ name, version: "qualification" }).status, "unsupported");
  }
  const base = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(base);
  const { webhook: _webhook, ...baseWithoutWebhook } = base;
  const directOnly: AgentCapability = {
    ...baseWithoutWebhook,
    kind: "fixture-direct",
    displayName: "Fixture Direct",
    aliases: ["fixture-direct"],
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
  assert.equal(
    resolveAgentCapability({ name: "fixture-direct", version: "1" }, [
      {
        ...directOnly,
        modes: ["direct", "webhook"],
      } as unknown as AgentCapability,
    ]).status,
    "unsupported",
  );
});

test("matches every known MCP client name without using its reported version as a gate", () => {
  for (const [name, kind] of [
    ["openclaw-bundle-mcp", "openclaw"],
    ["mcp", "hermes"],
    ["codex-mcp-client", "codex"],
    ["claude-code", "claude"],
  ] as const) {
    for (const version of ["0.0.1", "999.999.999", "future-release"]) {
      const result = resolveAgentCapability({ name, version });
      assert.equal(result.status, "matched", `${name} ${version}`);
      assert.equal(result.status === "matched" ? result.profile.kind : undefined, kind);
    }
  }
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
