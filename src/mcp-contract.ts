export const BOOTSTRAP_TOOLS = ["register_agent", "verify_email", "resend_verification"] as const;

export const AUTHENTICATED_TOOLS = [
  "list_action_types",
  "request_permission",
  "respond_to_permission",
  "call_action",
  "poll_messages",
  "get_my_permissions",
  "ack_message",
  "health_check",
] as const;

const FORBIDDEN_LOCAL_NAMES = new Set([
  "access_token",
  "agent_id",
  "authorization",
  "credential",
  "credential_id",
  "jwt",
  "token",
]);

const FORBIDDEN_RESULT_NAMES = new Set(["access_token", "authorization", "jwt", "token"]);

export class McpContractError extends Error {
  constructor() {
    super("Upstream MCP contract rejected");
    this.name = "McpContractError";
  }
}

export interface CentralToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface VerificationSuccess {
  token: string;
  localResult: {
    verified: true;
    agent_id: string;
    username: string;
    message: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoForbiddenNames(value: unknown, forbiddenNames: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenNames(item, forbiddenNames);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }

  for (const [name, nested] of Object.entries(value)) {
    if (forbiddenNames.has(name.toLowerCase())) {
      throw new McpContractError();
    }
    assertNoForbiddenNames(nested, forbiddenNames);
  }
}

function containsCredentialBytes(value: unknown, credential: string): boolean {
  if (typeof value === "string") return value.includes(credential);
  if (Array.isArray(value)) return value.some((item) => containsCredentialBytes(item, credential));
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([name, nested]) => name.includes(credential) || containsCredentialBytes(nested, credential),
  );
}

function parseSchema(value: unknown): Record<string, unknown> {
  if (!isObject(value) || value.type !== "object" || !isObject(value.properties)) {
    throw new McpContractError();
  }
  return value;
}

function parseTool(value: unknown): CentralToolDefinition {
  if (!isObject(value) || typeof value.name !== "string") {
    throw new McpContractError();
  }
  const inputSchema = parseSchema(value.inputSchema);
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new McpContractError();
  }
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema,
  };
}

export function selectCentralTools(catalog: unknown, enrolled: boolean): CentralToolDefinition[] {
  if (!Array.isArray(catalog)) {
    throw new McpContractError();
  }
  const allowed = new Set<string>(enrolled ? AUTHENTICATED_TOOLS : BOOTSTRAP_TOOLS);
  const selected = new Map<string, CentralToolDefinition>();

  for (const value of catalog) {
    const tool = parseTool(value);
    if (!allowed.has(tool.name)) {
      continue;
    }
    if (selected.has(tool.name)) {
      throw new McpContractError();
    }
    selected.set(tool.name, tool);
  }

  const required = enrolled ? AUTHENTICATED_TOOLS : BOOTSTRAP_TOOLS;
  return required.flatMap((name) => {
    const tool = selected.get(name);
    return tool === undefined ? [] : [tool];
  });
}

export function localToolDefinition(tool: CentralToolDefinition): CentralToolDefinition {
  const schema = parseSchema(tool.inputSchema);
  const properties = { ...(schema.properties as Record<string, unknown>) };
  delete properties.token;
  const required = schema.required;
  if (required !== undefined && !Array.isArray(required)) {
    throw new McpContractError();
  }
  const localRequired = (required ?? []).filter((name): name is string => {
    if (typeof name !== "string") {
      throw new McpContractError();
    }
    return name !== "token";
  });
  assertNoForbiddenNames(properties, FORBIDDEN_LOCAL_NAMES);

  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties,
      ...(localRequired.length === 0 ? { required: [] } : { required: localRequired }),
    },
  };
}

export function upstreamToolArguments(
  tool: CentralToolDefinition,
  localArguments: unknown,
  centralToken: string | undefined,
): Record<string, unknown> {
  if (!isObject(localArguments)) {
    throw new McpContractError();
  }
  assertNoForbiddenNames(localArguments, FORBIDDEN_LOCAL_NAMES);
  const properties = parseSchema(tool.inputSchema).properties as Record<string, unknown>;
  const requiresToken = Object.hasOwn(properties, "token");
  if (requiresToken && centralToken === undefined) {
    throw new McpContractError();
  }
  return {
    ...localArguments,
    ...(requiresToken ? { token: centralToken } : {}),
  };
}

export function assertSafeUpstreamResult(value: unknown, centralToken?: string): void {
  assertNoForbiddenNames(value, FORBIDDEN_RESULT_NAMES);
  if (centralToken !== undefined && containsCredentialBytes(value, centralToken)) {
    throw new McpContractError();
  }
}

export function parseVerificationSuccess(value: unknown): VerificationSuccess {
  if (!isObject(value)) {
    throw new McpContractError();
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "agent_id" ||
    keys[1] !== "message" ||
    keys[2] !== "token" ||
    keys[3] !== "username" ||
    typeof value.agent_id !== "string" ||
    value.agent_id.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.username !== "string" ||
    value.username.length === 0
  ) {
    throw new McpContractError();
  }

  const verified: VerificationSuccess = {
    token: value.token,
    localResult: {
      verified: true,
      agent_id: value.agent_id,
      username: value.username,
      message: value.message,
    },
  };
  assertSafeUpstreamResult(verified.localResult, verified.token);
  return verified;
}
