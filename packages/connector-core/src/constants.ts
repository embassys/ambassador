export const CONNECTOR_LIMITS = {
  activeTurnsPerConversation: 1,
  activeTurnsGlobal: 2,
  waitingWakeIds: 100,
  acceptedWebhookSockets: 32,
  parsedWebhookRequests: 16,
  webhookRequestLineBytes: 2_048,
  webhookHeaderBytes: 16_384,
  webhookBodyBytes: 1_048_576,
  webhookHeaderDeadlineMs: 2_000,
  webhookRequestDeadlineMs: 5_000,
  gatewayMcpDeadlineMs: 35_000,
  providerDeadlineMs: 900_000,
  cancellationGraceMs: 10_000,
  containmentCleanupMs: 3_000,
  normalizedEvents: 10_000,
  providerOutputBytes: 8_388_608,
  providerIdBytes: 1_024,
  finalReplyBytes: 262_144,
} as const;

export const PROVIDER_KINDS = ["codex", "claude", "gemini"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type ConnectorPolicy = "read-only" | "workspace-write";

export const WEBHOOK_TOKEN_PATTERN = /^[0-9a-f]{48}$/u;
export const URI_UNRESERVED_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
export const RETIREMENT_BYTES = Buffer.from("a2a-connector-retirement-v1\n", "ascii");

export class ConnectorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectorError";
  }
}

export function connectorError(code: string): never {
  throw new ConnectorError(code);
}
