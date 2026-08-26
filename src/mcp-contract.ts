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

function assertNoForbiddenRequiredNames(value: unknown, forbiddenNames: ReadonlySet<string>): void {
  if (!isObject(value)) return;

  const assertPropertyNames = (names: unknown): void => {
    if (!Array.isArray(names)) throw new McpContractError();
    for (const name of names) {
      if (typeof name !== "string" || forbiddenNames.has(name.toLowerCase())) {
        throw new McpContractError();
      }
    }
  };
  if (value.required !== undefined) assertPropertyNames(value.required);

  for (const keyword of [
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ]) {
    const schemas = value[keyword];
    if (schemas === undefined) continue;
    if (!isObject(schemas)) throw new McpContractError();
    for (const schema of Object.values(schemas)) {
      assertNoForbiddenRequiredNames(schema, forbiddenNames);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const schemas = value[keyword];
    if (schemas === undefined) continue;
    if (!Array.isArray(schemas)) throw new McpContractError();
    for (const schema of schemas) assertNoForbiddenRequiredNames(schema, forbiddenNames);
  }
  for (const keyword of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    assertNoForbiddenRequiredNames(value[keyword], forbiddenNames);
  }

  const items = value.items;
  if (Array.isArray(items)) {
    for (const schema of items) assertNoForbiddenRequiredNames(schema, forbiddenNames);
  } else {
    assertNoForbiddenRequiredNames(items, forbiddenNames);
  }
  const dependentRequired = value.dependentRequired;
  if (dependentRequired !== undefined) {
    if (!isObject(dependentRequired)) throw new McpContractError();
    for (const names of Object.values(dependentRequired)) assertPropertyNames(names);
  }
  const dependencies = value.dependencies;
  if (dependencies !== undefined) {
    if (!isObject(dependencies)) throw new McpContractError();
    for (const dependency of Object.values(dependencies)) {
      if (Array.isArray(dependency)) assertPropertyNames(dependency);
      else assertNoForbiddenRequiredNames(dependency, forbiddenNames);
    }
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
  const localSchema = {
    ...tool,
    inputSchema: {
      ...schema,
      properties,
      ...(localRequired.length === 0 ? { required: [] } : { required: localRequired }),
    },
  };
  assertNoForbiddenNames(localSchema.inputSchema, FORBIDDEN_LOCAL_NAMES);
  assertNoForbiddenRequiredNames(localSchema.inputSchema, FORBIDDEN_LOCAL_NAMES);
  return localSchema;
}

export function upstreamToolArguments(
  tool: CentralToolDefinition,
  localArguments: unknown,
  centralToken: string | undefined,
): Record<string, unknown> {
  const validatedArguments = safeLocalToolArguments(localArguments);
  const properties = parseSchema(tool.inputSchema).properties as Record<string, unknown>;
  const requiresToken = Object.hasOwn(properties, "token");
  if (requiresToken && centralToken === undefined) {
    throw new McpContractError();
  }
  return {
    ...validatedArguments,
    ...(requiresToken ? { token: centralToken } : {}),
  };
}

export function safeLocalToolArguments(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new McpContractError();
  assertNoForbiddenNames(value, FORBIDDEN_LOCAL_NAMES);
  return value;
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
  if (
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
  assertSafeUpstreamResult(
    Object.fromEntries(Object.entries(value).filter(([name]) => name !== "token")),
    verified.token,
  );
  return verified;
}
