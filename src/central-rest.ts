import {
  assertNoCentralCredentialFields,
  CentralJsonError,
  isCentralRecord,
  readCentralJson,
} from "./central-json.js";
import {
  type CentralProtectedTransport,
  CentralProtectedTransportError,
} from "./central-protected-transport.js";
import type { CentralToolDefinition } from "./mcp-contract.js";
import { validateNotificationId } from "./notification-journal.js";

const MAX_NORMALIZED_RESULT_BYTES = 512 * 1024;
const MAX_MESSAGES = 256;
const ORDINARY_DEADLINE_MS = 30_000;
const POLL_RESPONSE_MARGIN_MS = 10_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const NAME = /^[A-Za-z0-9._~-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ACP_TOOL_HUMAN_INPUT_TYPE = "ambassador_acp_tool_execution";
const INTERNAL_ACP_PERMISSION_TYPE =
  /^(?:ambassador_acp_tool_execution|acp_tool_execution_[a-f0-9]{32})$/u;
const FORBIDDEN_ARGUMENT_NAMES = new Set([
  "access_token",
  "authorization",
  "dpop",
  "jwt",
  "private_key",
  "proof",
  "token",
]);

export type CentralRestErrorCode =
  | "credential_expired"
  | "central_authentication_failed"
  | "central_request_failed"
  | "central_request_rejected"
  | "central_response_invalid"
  | "permission_missing"
  | "permission_pending"
  | "permission_denied"
  | "permission_expired"
  | "permission_spent"
  | "invalid_arguments";

export class CentralRestError extends Error {
  constructor(
    readonly code: CentralRestErrorCode,
    readonly response?: {
      readonly httpStatus: number;
      readonly notAccepted: boolean;
      readonly retryAfterMs?: number;
    },
  ) {
    super("Central REST operation failed");
    this.name = "CentralRestError";
  }
}

export interface CentralActionType {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface CentralMessage {
  readonly id?: string;
  readonly sender_agent_id: string;
  readonly action_type_id?: string | null;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

export interface CentralPermission {
  readonly id: string;
  readonly grantor_email: string;
  readonly grantee_email: string;
  readonly action_type: string;
  readonly status: "pending" | "granted" | "denied";
  readonly scope?: Record<string, unknown> | null;
  readonly created_at?: string | null;
  readonly decided_at?: string | null;
  readonly expires_at?: string | null;
}

export interface CentralPermissionRequestResult extends Record<string, unknown> {
  readonly permission_id: string;
  readonly status: "pending" | "granted" | "denied";
  readonly message: string;
  readonly decision?: "accept" | "deny" | "allow_once" | "allow_always" | null;
  readonly already_granted?: boolean;
}

export interface CentralHumanInputOption {
  readonly label: string;
  readonly value: string;
}

export interface CentralHumanInputRequest {
  readonly permission_type: string;
  readonly request: string;
  readonly input_type: "buttons" | "text";
  readonly options?: readonly CentralHumanInputOption[];
  readonly message_id: string;
}

export interface CentralHumanInputRequestResult extends Record<string, unknown> {
  readonly request_id: string;
  readonly status: "pending";
  readonly input_type: "buttons" | "text";
  readonly message: string;
  readonly options: readonly CentralHumanInputOption[] | null;
}

export interface CentralRestClientOptions {
  readonly centralOrigin: string;
  readonly transport: CentralProtectedTransport;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

export function normalizePermissionRequest(arguments_: unknown): Record<string, unknown> {
  if (
    !exactKeys(
      arguments_,
      [],
      [
        "target_email",
        "message_id",
        "action_type",
        "permission_type",
        "decision_options",
        "reason",
        "scope",
      ],
    ) ||
    (arguments_.target_email === undefined && arguments_.message_id === undefined) ||
    (arguments_.action_type === undefined) === (arguments_.permission_type === undefined) ||
    (arguments_.decision_options !== undefined &&
      arguments_.decision_options !== "accept_deny" &&
      arguments_.decision_options !== "once_always") ||
    (arguments_.reason !== undefined &&
      (typeof arguments_.reason !== "string" || arguments_.reason.length > 500))
  ) {
    throw failure("invalid_arguments");
  }
  const body = {
    ...(arguments_.target_email === undefined
      ? {}
      : { target_email: requestEmail(arguments_.target_email) }),
    ...(arguments_.message_id === undefined
      ? {}
      : { message_id: requestUuid(arguments_.message_id) }),
    ...(arguments_.action_type === undefined
      ? { permission_type: requestPermissionName(arguments_.permission_type) }
      : { action_type: requestPermissionName(arguments_.action_type) }),
    ...(arguments_.decision_options === undefined
      ? {}
      : { decision_options: arguments_.decision_options }),
    ...(arguments_.reason === undefined ? {} : { reason: arguments_.reason }),
    ...(arguments_.scope === undefined
      ? {}
      : { scope: arguments_.scope === null ? null : requestObject(arguments_.scope) }),
  };
  return body;
}

export const REST_AUTHENTICATED_TOOLS: readonly CentralToolDefinition[] = [
  {
    name: "list_action_types",
    description:
      "Use this Embassys Ambassador tool when the user asks what Embassys actions are available or what another agent can request. List the deployed action names and input schemas.",
    inputSchema: objectSchema({}),
  },
  {
    name: "get_my_permissions",
    description:
      "Read the verified Embassys enrollment identity and all its permissions, including requests made by or to it. A successful response confirms registration even when permissions is empty. Use enrollment.email for the registered identity; do not infer registration state from the permission count.",
    inputSchema: objectSchema({}),
  },
] as const;

function failure(code: CentralRestErrorCode): CentralRestError {
  return new CentralRestError(code);
}

function origin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failure("invalid_arguments");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw failure("invalid_arguments");
  }
  return parsed;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isCentralRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).every((name) => allowed.has(name))
  );
}

function noForbiddenArguments(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) noForbiddenArguments(item);
    return;
  }
  if (!isCentralRecord(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    if (FORBIDDEN_ARGUMENT_NAMES.has(name.toLowerCase())) throw failure("invalid_arguments");
    noForbiddenArguments(nested);
  }
}

function requestEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) {
    throw failure("invalid_arguments");
  }
  return value;
}

function requestName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) throw failure("invalid_arguments");
  return value;
}

function requestPermissionName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw failure("invalid_arguments");
  }
  return value;
}

function requestHumanInputText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw failure("invalid_arguments");
  }
  return value;
}

function humanInputOption(value: unknown): CentralHumanInputOption {
  if (
    !exactKeys(value, ["label", "value"]) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 64 ||
    typeof value.value !== "string" ||
    value.value.length < 1 ||
    value.value.length > 64
  ) {
    throw failure("central_response_invalid");
  }
  return { label: value.label, value: value.value };
}

function requestUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw failure("invalid_arguments");
  return value;
}

function requestObject(value: unknown): Record<string, unknown> {
  if (!isCentralRecord(value)) throw failure("invalid_arguments");
  noForbiddenArguments(value);
  return value;
}

function safeResultSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw failure("central_response_invalid");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_NORMALIZED_RESULT_BYTES) {
    throw failure("central_response_invalid");
  }
}

function actionType(value: unknown): CentralActionType {
  if (
    !exactKeys(value, ["id", "name", "description", "input_schema"]) ||
    typeof value.id !== "string" ||
    !NAME.test(value.id) ||
    typeof value.name !== "string" ||
    !NAME.test(value.name) ||
    typeof value.description !== "string" ||
    value.description.length > 1_024 ||
    !isCentralRecord(value.input_schema) ||
    value.input_schema.type !== "object"
  ) {
    throw failure("central_response_invalid");
  }
  assertNoCentralCredentialFields(value.input_schema);
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    input_schema: value.input_schema,
  };
}

function message(value: unknown): CentralMessage {
  if (
    !exactKeys(value, ["sender_agent_id", "payload", "created_at"], ["id", "action_type_id"]) ||
    (value.id !== undefined && (typeof value.id !== "string" || !NAME.test(value.id))) ||
    typeof value.sender_agent_id !== "string" ||
    value.sender_agent_id.length > 256 ||
    (value.action_type_id !== undefined &&
      value.action_type_id !== null &&
      (typeof value.action_type_id !== "string" || value.action_type_id.length > 256)) ||
    !isCentralRecord(value.payload) ||
    typeof value.created_at !== "string" ||
    value.created_at.length > 128
  ) {
    throw failure("central_response_invalid");
  }
  assertNoCentralCredentialFields(value.payload);
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    sender_agent_id: value.sender_agent_id,
    ...(value.action_type_id === undefined ? {} : { action_type_id: value.action_type_id }),
    payload: value.payload,
    created_at: value.created_at,
  };
}

function permission(value: unknown): CentralPermission {
  if (
    !exactKeys(
      value,
      ["id", "grantor_email", "grantee_email", "action_type", "status"],
      ["scope", "created_at", "decided_at", "expires_at"],
    ) ||
    typeof value.id !== "string" ||
    !NAME.test(value.id) ||
    typeof value.grantor_email !== "string" ||
    !EMAIL.test(value.grantor_email) ||
    typeof value.grantee_email !== "string" ||
    !EMAIL.test(value.grantee_email) ||
    typeof value.action_type !== "string" ||
    !NAME.test(value.action_type) ||
    !["pending", "granted", "denied"].includes(value.status as string) ||
    (value.scope !== undefined && value.scope !== null && !isCentralRecord(value.scope)) ||
    !["created_at", "decided_at", "expires_at"].every(
      (name) =>
        value[name] === undefined || value[name] === null || typeof value[name] === "string",
    )
  ) {
    throw failure("central_response_invalid");
  }
  assertNoCentralCredentialFields(value);
  return value as unknown as CentralPermission;
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class CentralRestClient {
  readonly #origin: URL;
  readonly #transport: CentralProtectedTransport;

  constructor(options: CentralRestClientOptions) {
    this.#origin = origin(options.centralOrigin);
    this.#transport = options.transport;
  }

  async listActionTypes(signal?: AbortSignal): Promise<CentralActionType[]> {
    const result = await this.#request("GET", "/api/list_action_types", undefined, signal);
    if (!Array.isArray(result) || result.length > 128) throw failure("central_response_invalid");
    const actions = result
      .filter(
        (value) =>
          !(
            isCentralRecord(value) &&
            typeof value.name === "string" &&
            INTERNAL_ACP_PERMISSION_TYPE.test(value.name)
          ),
      )
      .map(actionType);
    if (new Set(actions.map((action) => action.name)).size !== actions.length) {
      throw failure("central_response_invalid");
    }
    safeResultSize(actions);
    return actions;
  }

  async requestPermission(
    arguments_: unknown,
    signal?: AbortSignal,
  ): Promise<CentralPermissionRequestResult> {
    const body = normalizePermissionRequest(arguments_);
    const result = await this.#request("POST", "/api/request_permission", body, signal);
    if (
      !exactKeys(result, ["permission_id", "status", "message"], ["already_granted", "decision"]) ||
      typeof result.permission_id !== "string" ||
      !NAME.test(result.permission_id) ||
      !["pending", "granted", "denied"].includes(result.status as string) ||
      typeof result.message !== "string" ||
      result.message.length > 512 ||
      (result.already_granted !== undefined && typeof result.already_granted !== "boolean") ||
      (result.decision !== undefined &&
        result.decision !== null &&
        result.decision !== "accept" &&
        result.decision !== "deny" &&
        result.decision !== "allow_once" &&
        result.decision !== "allow_always")
    ) {
      throw failure("central_response_invalid");
    }
    return result as CentralPermissionRequestResult;
  }

  async requestHumanInput(
    arguments_: CentralHumanInputRequest,
    signal?: AbortSignal,
  ): Promise<CentralHumanInputRequestResult> {
    if (
      !exactKeys(
        arguments_,
        ["permission_type", "request", "input_type", "message_id"],
        ["options"],
      ) ||
      !["buttons", "text"].includes(arguments_.input_type) ||
      (arguments_.input_type === "buttons"
        ? !Array.isArray(arguments_.options) ||
          arguments_.options.length < 1 ||
          arguments_.options.length > 10
        : arguments_.options !== undefined)
    )
      throw failure("invalid_arguments");
    const options =
      arguments_.input_type === "text"
        ? null
        : (arguments_.options ?? []).map((option) => {
            try {
              return humanInputOption(option);
            } catch {
              throw failure("invalid_arguments");
            }
          });
    if (options !== null && new Set(options.map(({ value }) => value)).size !== options.length)
      throw failure("invalid_arguments");
    const body = {
      permission_type: requestPermissionName(arguments_.permission_type),
      request: requestHumanInputText(arguments_.request, 2_000),
      input_type: arguments_.input_type,
      ...(options === null ? {} : { options }),
      message_id: requestUuid(arguments_.message_id),
    };
    const result = await this.#request("POST", "/api/get_human_input", body, signal);
    if (
      !exactKeys(result, ["request_id", "status", "input_type", "message", "options"]) ||
      typeof result.request_id !== "string" ||
      !UUID.test(result.request_id) ||
      result.status !== "pending" ||
      result.input_type !== arguments_.input_type ||
      typeof result.message !== "string" ||
      result.message.length > 512 ||
      (options === null ? result.options !== null : !Array.isArray(result.options))
    )
      throw failure("central_response_invalid");
    const returned = options === null ? null : (result.options as unknown[]).map(humanInputOption);
    if (JSON.stringify(returned) !== JSON.stringify(options))
      throw failure("central_response_invalid");
    return {
      request_id: result.request_id,
      status: "pending",
      input_type: arguments_.input_type,
      message: result.message,
      options: returned,
    };
  }

  async callAction(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!exactKeys(arguments_, ["target_email", "action_type", "payload"])) {
      throw failure("invalid_arguments");
    }
    const result = await this.#request(
      "POST",
      "/api/call_action",
      {
        target_email: requestEmail(arguments_.target_email),
        action_type: requestName(arguments_.action_type),
        payload: requestObject(arguments_.payload),
      },
      signal,
    );
    if (
      !exactKeys(result, ["call_id", "message_id", "status"]) ||
      typeof result.call_id !== "string" ||
      !UUID.test(result.call_id) ||
      typeof result.message_id !== "string" ||
      !NAME.test(result.message_id) ||
      result.status !== "delivered"
    ) {
      throw failure("central_response_invalid");
    }
    return result;
  }

  async submitActionResult(
    arguments_: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (
      !exactKeys(arguments_, ["call_id", "result", "status"]) ||
      (arguments_.status !== "success" && arguments_.status !== "error")
    ) {
      throw failure("invalid_arguments");
    }
    const callId = requestUuid(arguments_.call_id);
    const requestedStatus = arguments_.status;
    const result = await this.#request(
      "POST",
      "/api/submit_action_result",
      {
        call_id: callId,
        result: requestObject(arguments_.result),
        status: requestedStatus,
      },
      signal,
    );
    const expectedStatus = requestedStatus === "success" ? "completed" : "failed";
    if (
      !exactKeys(result, ["call_id", "status", "message_id"]) ||
      result.call_id !== callId ||
      result.status !== expectedStatus ||
      typeof result.message_id !== "string" ||
      !NAME.test(result.message_id)
    ) {
      throw failure("central_response_invalid");
    }
    return result;
  }

  async pollRemoteMessages(
    timeout: number,
    signal?: AbortSignal,
  ): Promise<{ readonly messages: CentralMessage[] }> {
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60) {
      throw failure("invalid_arguments");
    }
    const result = await this.#request(
      "GET",
      `/api/poll_messages?timeout=${timeout}`,
      undefined,
      signal,
      Math.max(ORDINARY_DEADLINE_MS, timeout * 1_000 + POLL_RESPONSE_MARGIN_MS),
    );
    if (!exactKeys(result, ["messages"]) || !Array.isArray(result.messages)) {
      throw failure("central_response_invalid");
    }
    if (result.messages.length > MAX_MESSAGES) throw failure("central_response_invalid");
    const messages = result.messages.map(message);
    const byId = new Map<string, string>();
    for (const value of messages) {
      if (value.id === undefined) continue;
      const serialized = JSON.stringify(value);
      const existing = byId.get(value.id);
      if (existing !== undefined && existing !== serialized)
        throw failure("central_response_invalid");
      byId.set(value.id, serialized);
    }
    safeResultSize({ messages });
    return { messages };
  }

  async getMyPermissions(signal?: AbortSignal): Promise<CentralPermission[]> {
    const result = await this.#request("GET", "/api/get_my_permissions", undefined, signal);
    if (!Array.isArray(result) || result.length > 512) throw failure("central_response_invalid");
    const permissions = result.map(permission);
    safeResultSize(permissions);
    return permissions;
  }

  async ackMessage(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!exactKeys(arguments_, ["message_id"])) throw failure("invalid_arguments");
    let messageId: string;
    try {
      messageId = validateNotificationId(arguments_.message_id);
    } catch {
      throw failure("invalid_arguments");
    }
    const result = await this.#request(
      "POST",
      "/api/ack_message",
      { message_id: messageId },
      signal,
    );
    if (
      !exactKeys(result, ["message_id", "status"]) ||
      result.message_id !== messageId ||
      result.status !== "acked"
    ) {
      throw failure("central_response_invalid");
    }
    return { message_id: messageId, status: "acked" };
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#transport.fetch(
        new URL(path, this.#origin),
        {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        },
        deadlineMs,
      );
    } catch (error) {
      if (error instanceof CentralProtectedTransportError) {
        if (error.code === "central_protected_credential_expired") {
          throw failure("credential_expired");
        }
        if (error.code === "central_protected_authentication_failed") {
          throw failure("central_authentication_failed");
        }
        if (error.code === "central_protected_request_failed") {
          throw failure("central_request_failed");
        }
      }
      throw failure("central_request_failed");
    }
    if (!response.ok) {
      // These statuses occur before acceptance in the reviewed mutation handlers.
      // Unknown statuses and server errors can follow committed writes.
      const rejectedStatuses =
        path === "/api/request_permission"
          ? [400, 403, 404, 409, 422, 429]
          : path === "/api/call_action"
            ? [400, 403, 404, 422, 429]
            : [];
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs =
        response.status === 429 && retryAfter !== null && /^\d{1,5}$/u.test(retryAfter)
          ? Math.min(Number(retryAfter) * 1_000, 24 * 60 * 60 * 1_000)
          : undefined;
      let rejection: unknown;
      try {
        rejection = await readCentralJson(response, 64 * 1024);
      } catch {
        await cancel(response);
      }
      const permissionReason =
        path === "/api/call_action" &&
        response.status === 403 &&
        isCentralRecord(rejection) &&
        typeof rejection.detail === "string"
          ? (
              {
                "No permission exists for this action": "permission_missing",
                "Permission is pending, not granted": "permission_pending",
                "Permission is denied, not granted": "permission_denied",
                "Permission has expired": "permission_expired",
                "This permission was granted for a single use, which has already been spent. Request permission again.":
                  "permission_spent",
              } as Record<string, CentralRestErrorCode>
            )[rejection.detail]
          : undefined;
      throw new CentralRestError(
        response.status === 401
          ? "central_authentication_failed"
          : (permissionReason ?? "central_request_rejected"),
        {
          httpStatus: response.status,
          notAccepted: rejectedStatuses.includes(response.status),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }
    try {
      const result = await readCentralJson(response);
      assertNoCentralCredentialFields(result);
      return result;
    } catch (error) {
      if (error instanceof CentralJsonError) throw failure("central_response_invalid");
      if (error instanceof CentralRestError) throw error;
      throw failure("central_response_invalid");
    }
  }
}
