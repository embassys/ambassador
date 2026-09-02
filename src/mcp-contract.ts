const FORBIDDEN_LOCAL_NAMES = new Set([
  "access_token",
  "authorization",
  "dpop",
  "jwt",
  "private_key",
  "proof",
  "token",
]);

const FORBIDDEN_RESULT_NAMES = new Set([
  "access_token",
  "authorization",
  "dpop",
  "jwt",
  "private_key",
  "proof",
  "token",
]);

export class McpContractError extends Error {
  constructor() {
    super("The local MCP contract is invalid");
    this.name = "McpContractError";
  }
}

export interface CentralToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoNames(value: unknown, forbidden: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoNames(item, forbidden);
    return;
  }
  if (!isRecord(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    if (forbidden.has(name.toLowerCase())) throw new McpContractError();
    assertNoNames(nested, forbidden);
  }
}

function containsBytes(value: unknown, bytes: string): boolean {
  if (typeof value === "string") return value.includes(bytes);
  if (Array.isArray(value)) return value.some((item) => containsBytes(item, bytes));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([name, nested]) => name.includes(bytes) || containsBytes(nested, bytes),
  );
}

export function safeLocalToolArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new McpContractError();
  assertNoNames(value, FORBIDDEN_LOCAL_NAMES);
  return value;
}

export function assertSafeUpstreamResult(value: unknown, centralToken?: string): void {
  assertNoNames(value, FORBIDDEN_RESULT_NAMES);
  if (centralToken !== undefined && containsBytes(value, centralToken)) {
    throw new McpContractError();
  }
}
