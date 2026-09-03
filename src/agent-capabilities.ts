export type DeliveryMode = "direct" | "webhook";
export type McpConfigurationBehavior = "provider_config" | "session";

export interface AgentClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface WindowsNodePackageEntrypoint {
  readonly packageName: string;
  readonly binName: string;
  readonly entrypoint: string;
}

export interface DirectAgentCapability {
  readonly command: string;
  readonly args: readonly string[];
  readonly agentInfo: {
    readonly name: string;
  };
  readonly mcp: McpConfigurationBehavior;
  readonly environment: readonly string[];
  readonly windowsNodePackage?: WindowsNodePackageEntrypoint;
}

export interface AgentCapability {
  readonly kind: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly aliases: readonly string[];
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
    aliases: ["openclaw-bundle-mcp"],
    modes: ["direct", "webhook"],
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
      windowsNodePackage: {
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
      windowsNodePackage: {
        packageName: "@agentclientprotocol/claude-agent-acp",
        binName: "claude-agent-acp",
        entrypoint: "dist/index.js",
      },
    },
    qualificationCases: ["claude-direct"],
  },
  {
    kind: "gemini",
    displayName: "Gemini CLI",
    enabled: true,
    aliases: ["gemini-cli-mcp-client"],
    modes: ["direct"],
    direct: {
      command: "gemini",
      args: ["--acp"],
      agentInfo: { name: "gemini-cli" },
      mcp: "session",
      environment: [
        "APPDATA",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
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
        packageName: "@google/gemini-cli",
        binName: "gemini",
        entrypoint: "bundle/gemini.js",
      },
    },
    qualificationCases: ["gemini-direct"],
  },
] as const;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function completeDirect(value: DirectAgentCapability | undefined): boolean {
  const windowsNodePackage = value?.windowsNodePackage;
  const completeWindowsNodePackage =
    windowsNodePackage === undefined ||
    (BOUNDED_METADATA.test(windowsNodePackage.packageName) &&
      windowsNodePackage.binName === value?.command &&
      BOUNDED_METADATA.test(windowsNodePackage.entrypoint) &&
      !windowsNodePackage.entrypoint.includes("\\") &&
      windowsNodePackage.entrypoint
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."));
  return (
    value !== undefined &&
    BOUNDED_METADATA.test(value.command) &&
    value.args.length <= 16 &&
    value.args.every((argument) => BOUNDED_METADATA.test(argument)) &&
    BOUNDED_METADATA.test(value.agentInfo.name) &&
    (value.mcp === "provider_config" || value.mcp === "session") &&
    value.environment.length <= 32 &&
    value.environment.every((name) => ENVIRONMENT_NAME.test(name)) &&
    unique(value.environment) &&
    completeWindowsNodePackage
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
  if (!unique(value.aliases) || !value.aliases.every((name) => BOUNDED_METADATA.test(name))) {
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
      profile.aliases.includes(clientInfo.name),
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
