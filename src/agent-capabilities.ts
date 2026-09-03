export type DeliveryMode = "direct" | "webhook";
export type McpConfigurationBehavior = "provider_config" | "session";

export interface AgentClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface DirectAgentCapability {
  readonly command: string;
  readonly args: readonly string[];
  readonly agentInfo: {
    readonly name: string;
    readonly versions: readonly string[];
  };
  readonly mcp: McpConfigurationBehavior;
  readonly environment: readonly string[];
}

export interface AgentCapability {
  readonly kind: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly aliases: readonly AgentClientInfo[];
  readonly modes: readonly DeliveryMode[];
  readonly direct?: DirectAgentCapability;
  readonly qualificationCases: readonly string[];
}

export type AgentCapabilityResolution =
  | { readonly status: "matched"; readonly profile: AgentCapability }
  | { readonly status: "unsupported" };

const BOUNDED_METADATA = /^[\x20-\x7e]{1,128}$/u;
const KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const PRODUCTION_AGENT_CAPABILITIES: readonly AgentCapability[] = [
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
      agentInfo: { name: "hermes-agent", versions: ["0.20.5", "0.21.0"] },
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
] as const;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function completeDirect(value: DirectAgentCapability | undefined): boolean {
  return (
    value !== undefined &&
    BOUNDED_METADATA.test(value.command) &&
    value.args.length <= 16 &&
    value.args.every((argument) => BOUNDED_METADATA.test(argument)) &&
    BOUNDED_METADATA.test(value.agentInfo.name) &&
    value.agentInfo.versions.length > 0 &&
    value.agentInfo.versions.length <= 16 &&
    value.agentInfo.versions.every((version) => BOUNDED_METADATA.test(version)) &&
    unique(value.agentInfo.versions) &&
    (value.mcp === "provider_config" || value.mcp === "session") &&
    value.environment.length <= 32 &&
    value.environment.every((name) => ENVIRONMENT_NAME.test(name)) &&
    unique(value.environment)
  );
}

export function isCompleteAgentCapability(value: AgentCapability): boolean {
  if (
    !KIND.test(value.kind) ||
    !BOUNDED_METADATA.test(value.displayName) ||
    value.aliases.length === 0 ||
    value.aliases.length > 16 ||
    value.modes.length === 0 ||
    value.modes.length > 2 ||
    !unique(value.modes) ||
    value.qualificationCases.length === 0 ||
    value.qualificationCases.length > 16 ||
    !value.qualificationCases.every((item) => BOUNDED_METADATA.test(item)) ||
    !unique(value.qualificationCases)
  ) {
    return false;
  }
  const aliases = value.aliases.map(({ name, version }) => `${name}\u0000${version}`);
  if (
    !unique(aliases) ||
    !value.aliases.every(
      ({ name, version }) => BOUNDED_METADATA.test(name) && BOUNDED_METADATA.test(version),
    )
  ) {
    return false;
  }
  if (value.modes.some((mode) => mode !== "direct" && mode !== "webhook")) return false;
  return value.modes.includes("direct") ? completeDirect(value.direct) : value.direct === undefined;
}

function boundedClientInfo(value: AgentClientInfo | undefined): value is AgentClientInfo {
  return (
    value !== undefined && BOUNDED_METADATA.test(value.name) && BOUNDED_METADATA.test(value.version)
  );
}

export function resolveAgentCapability(
  clientInfo: AgentClientInfo | undefined,
  registry: readonly AgentCapability[] = PRODUCTION_AGENT_CAPABILITIES,
): AgentCapabilityResolution {
  if (!boundedClientInfo(clientInfo)) return { status: "unsupported" };
  const matches = registry.filter(
    (profile) =>
      profile.enabled &&
      isCompleteAgentCapability(profile) &&
      profile.aliases.some(
        (alias) => alias.name === clientInfo.name && alias.version === clientInfo.version,
      ),
  );
  return matches.length === 1 && matches[0] !== undefined
    ? { status: "matched", profile: matches[0] }
    : { status: "unsupported" };
}

export function capabilityForKind(
  kind: string,
  registry: readonly AgentCapability[] = PRODUCTION_AGENT_CAPABILITIES,
): AgentCapability | undefined {
  const matches = registry.filter(
    (profile) => profile.kind === kind && profile.enabled && isCompleteAgentCapability(profile),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
