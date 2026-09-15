import {
  actionName,
  agentAddress,
  availableActionNames,
  validActionName,
} from "./agent-address.js";
import {
  assertNoCentralCredentialFields,
  CentralJsonError,
  isCentralRecord,
  readCentralJson,
} from "./central-json.js";
import type { CentralMutation, CentralMutations, MutationReceipt } from "./central-mutations.js";
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
  | "executor_inactive"
  | "central_request_failed"
  | "central_request_rejected"
  | "central_response_invalid"
  | "action_not_accepted"
  | "permission_missing"
  | "permission_pending"
  | "permission_denied"
  | "permission_revoked"
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
  readonly result_schema?: Record<string, unknown> | null;
  readonly verified?: boolean;
}

export interface CentralAvailableActions {
  readonly agent_email: string;
  readonly available_actions: string[] | null;
  readonly restricted: boolean;
}

export interface CentralActionProgress {
  readonly call_id: string;
  readonly call_status: "pending" | "completed" | "failed";
  readonly events: readonly {
    readonly event_id: string;
    readonly sequence: number;
    readonly state: "working" | "waiting_for_owner_input" | "failed";
    readonly note?: string | null;
    readonly reported_at: string;
  }[];
}

function availableActions(value: unknown): CentralAvailableActions {
  if (
    !exactKeys(value, ["agent_email", "available_actions", "restricted"]) ||
    typeof value.agent_email !== "string" ||
    !EMAIL.test(value.agent_email) ||
    value.agent_email.length > 254 ||
    typeof value.restricted !== "boolean" ||
    value.restricted !== (value.available_actions !== null) ||
    (value.available_actions !== null &&
      (!Array.isArray(value.available_actions) ||
        value.available_actions.length > 500 ||
        !value.available_actions.every(validActionName) ||
        new Set(value.available_actions).size !== value.available_actions.length))
  )
    throw failure("central_response_invalid");
  return value as unknown as CentralAvailableActions;
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
  readonly status: "pending" | "granted" | "denied" | "revoked" | "expired";
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
  readonly request_kind?: "text_answer" | "provider_option";
  readonly provider?: {
    readonly provider_key: string;
    readonly generation: number;
    readonly expires_in_seconds?: number;
  };
  readonly expires_in_seconds?: number;
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
  readonly mutations?: CentralMutations;
  readonly beforeRequest?: (signal?: AbortSignal) => Promise<void>;
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
      "Use this Embassys Ambassador tool when the user asks what Embassys actions are available or what another agent can request. List the deployed action names, schemas and review status. Set verified_only to true for reviewed actions only; omit it to include custom actions. Review status is not a permission grant or a provider capability guarantee.",
    inputSchema: objectSchema({ verified_only: { type: "boolean" } }),
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
  const parsed = agentAddress.safeParse(value);
  if (!parsed.success) throw failure("invalid_arguments");
  return parsed.data;
}

function requestName(value: unknown): string {
  const parsed = actionName.safeParse(value);
  if (!parsed.success) throw failure("invalid_arguments");
  return parsed.data;
}

function requestPermissionName(value: unknown): string {
  return requestName(value);
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
    !exactKeys(
      value,
      ["id", "name", "description", "input_schema"],
      ["result_schema", "verified"],
    ) ||
    typeof value.id !== "string" ||
    !NAME.test(value.id) ||
    typeof value.name !== "string" ||
    !validActionName(value.name) ||
    typeof value.description !== "string" ||
    value.description.length > 1_024 ||
    !isCentralRecord(value.input_schema) ||
    (value.verified !== undefined && typeof value.verified !== "boolean") ||
    (value.result_schema !== undefined &&
      value.result_schema !== null &&
      !isCentralRecord(value.result_schema))
  ) {
    throw failure("central_response_invalid");
  }
  assertNoCentralCredentialFields(value.input_schema);
  if (value.result_schema != null) assertNoCentralCredentialFields(value.result_schema);
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    input_schema: value.input_schema,
    ...(value.result_schema === undefined ? {} : { result_schema: value.result_schema }),
    ...(value.verified === undefined ? {} : { verified: value.verified }),
  };
}

function message(value: unknown): CentralMessage {
  if (
    !exactKeys(
      value,
      ["sender_agent_id", "payload", "created_at"],
      [
        "id",
        "action_type_id",
        "message_type",
        "delivery_attempts",
        "redelivered",
        "lease_expires_at",
      ],
    ) ||
    (value.id !== undefined && (typeof value.id !== "string" || !NAME.test(value.id))) ||
    typeof value.sender_agent_id !== "string" ||
    value.sender_agent_id.length > 256 ||
    (value.action_type_id !== undefined &&
      value.action_type_id !== null &&
      (typeof value.action_type_id !== "string" || value.action_type_id.length > 256)) ||
    (value.message_type != null &&
      (typeof value.message_type !== "string" || !NAME.test(value.message_type))) ||
    (value.delivery_attempts !== undefined &&
      (!Number.isSafeInteger(value.delivery_attempts) ||
        (value.delivery_attempts as number) < 1)) ||
    (value.redelivered !== undefined && typeof value.redelivered !== "boolean") ||
    (value.lease_expires_at != null &&
      (typeof value.lease_expires_at !== "string" ||
        value.lease_expires_at.length > 128 ||
        !Number.isFinite(Date.parse(value.lease_expires_at)))) ||
    !isCentralRecord(value.payload) ||
    typeof value.created_at !== "string" ||
    value.created_at.length > 128
  ) {
    throw failure("central_response_invalid");
  }
  assertNoCentralCredentialFields(value.payload);
  // Delivery attempts and leases change on redelivery. They must not change
  // the canonical body used by durable custody to detect conflicting IDs.
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
    !validActionName(value.action_type) ||
    !["pending", "granted", "denied", "revoked", "expired"].includes(value.status as string) ||
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
  readonly #mutations: CentralMutations | undefined;
  readonly #beforeRequest: CentralRestClientOptions["beforeRequest"];

  constructor(options: CentralRestClientOptions) {
    this.#origin = origin(options.centralOrigin);
    this.#transport = options.transport;
    this.#mutations = options.mutations;
    this.#beforeRequest = options.beforeRequest;
  }

  async listActionTypes(
    signal?: AbortSignal,
    options: { readonly verified_only?: boolean } = {},
  ): Promise<CentralActionType[]> {
    if (
      !exactKeys(options, [], ["verified_only"]) ||
      (options.verified_only !== undefined && typeof options.verified_only !== "boolean")
    )
      throw failure("invalid_arguments");
    const query = options.verified_only === true ? "?verified_only=true" : "";
    const result = await this.#request("GET", `/api/list_action_types${query}`, undefined, signal);
    if (!Array.isArray(result) || result.length > 5000) throw failure("central_response_invalid");
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
    if (options.verified_only && actions.some((action) => action.verified !== true))
      throw failure("central_response_invalid");
    safeResultSize(actions);
    return actions;
  }

  async getAvailableActions(
    address?: string,
    signal?: AbortSignal,
  ): Promise<CentralAvailableActions> {
    const query =
      address === undefined
        ? ""
        : `?${new URLSearchParams({ agent_email: requestEmail(address) })}`;
    return availableActions(
      await this.#request("GET", `/api/available_actions${query}`, undefined, signal),
    );
  }

  async setAvailableActions(
    names: readonly string[],
    signal?: AbortSignal,
  ): Promise<CentralAvailableActions> {
    const parsed = availableActionNames.safeParse(names);
    if (!parsed.success) throw failure("invalid_arguments");
    const requested = [...new Set(parsed.data)];
    const result = availableActions(
      await this.#request(
        "PUT",
        "/api/available_actions",
        { available_actions: requested },
        signal,
      ),
    );
    if (
      !result.restricted ||
      JSON.stringify(result.available_actions) !== JSON.stringify(requested)
    )
      throw failure("central_response_invalid");
    return result;
  }

  async requestPermission(
    arguments_: unknown,
    signal?: AbortSignal,
    requestKey?: string,
  ): Promise<CentralPermissionRequestResult> {
    const body = normalizePermissionRequest(arguments_);
    const result = await this.#request(
      "POST",
      "/api/request_permission",
      body,
      signal,
      undefined,
      requestKey,
    );
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
    requestKey?: string,
  ): Promise<CentralHumanInputRequestResult> {
    if (
      !exactKeys(
        arguments_,
        ["permission_type", "request", "input_type", "message_id"],
        ["options", "request_kind", "provider", "expires_in_seconds"],
      ) ||
      !["buttons", "text"].includes(arguments_.input_type) ||
      (arguments_.input_type === "buttons"
        ? !Array.isArray(arguments_.options) ||
          arguments_.options.length < 1 ||
          arguments_.options.length > 10
        : arguments_.options !== undefined)
    )
      throw failure("invalid_arguments");
    const expiryValid = (value: unknown) =>
      value === undefined ||
      (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 604800);
    if (
      (arguments_.request_kind !== undefined &&
        !["text_answer", "provider_option"].includes(arguments_.request_kind)) ||
      !expiryValid(arguments_.expires_in_seconds) ||
      (arguments_.request_kind === "provider_option"
        ? !exactKeys(arguments_.provider, ["provider_key", "generation"], ["expires_in_seconds"]) ||
          typeof arguments_.provider.provider_key !== "string" ||
          arguments_.provider.provider_key.length < 1 ||
          arguments_.provider.provider_key.length > 128 ||
          !Number.isSafeInteger(arguments_.provider.generation) ||
          arguments_.provider.generation < 1 ||
          !expiryValid(arguments_.provider.expires_in_seconds)
        : arguments_.provider !== undefined)
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
      ...(arguments_.request_kind === undefined ? {} : { request_kind: arguments_.request_kind }),
      ...(arguments_.provider === undefined ? {} : { provider: arguments_.provider }),
      ...(arguments_.expires_in_seconds === undefined
        ? {}
        : { expires_in_seconds: arguments_.expires_in_seconds }),
    };
    const result = await this.#request(
      "POST",
      "/api/get_human_input",
      body,
      signal,
      undefined,
      requestKey,
    );
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

  async callAction(
    arguments_: unknown,
    signal?: AbortSignal,
    requestKey?: string,
  ): Promise<Record<string, unknown>> {
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
      undefined,
      requestKey,
    );
    if (
      !exactKeys(result, ["call_id", "message_id", "status"]) ||
      typeof result.call_id !== "string" ||
      !UUID.test(result.call_id) ||
      typeof result.message_id !== "string" ||
      !NAME.test(result.message_id) ||
      result.status !== "queued"
    ) {
      throw failure("central_response_invalid");
    }
    return result;
  }

  async submitActionResult(
    arguments_: unknown,
    signal?: AbortSignal,
    requestKey?: string,
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
      undefined,
      requestKey,
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

  async reportActionProgress(
    arguments_: {
      call_id: string;
      state: "working" | "waiting_for_owner_input" | "failed";
      note?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (
      !exactKeys(arguments_, ["call_id", "state"], ["note"]) ||
      !["working", "waiting_for_owner_input", "failed"].includes(arguments_.state) ||
      (arguments_.note !== undefined &&
        (typeof arguments_.note !== "string" || arguments_.note.length > 200))
    )
      throw failure("invalid_arguments");
    const callId = requestUuid(arguments_.call_id);
    const result = await this.#request(
      "POST",
      "/api/report_action_progress",
      { ...arguments_, call_id: callId },
      signal,
    );
    if (
      !exactKeys(result, ["call_id", "event_id", "sequence", "state", "message_id", "duplicate"]) ||
      result.call_id !== callId ||
      typeof result.event_id !== "string" ||
      !UUID.test(result.event_id) ||
      !Number.isSafeInteger(result.sequence) ||
      (result.sequence as number) < 1 ||
      result.state !== arguments_.state ||
      (result.message_id !== null &&
        (typeof result.message_id !== "string" || !UUID.test(result.message_id))) ||
      typeof result.duplicate !== "boolean"
    )
      throw failure("central_response_invalid");
    return result;
  }

  async getActionProgress(callId: string, signal?: AbortSignal): Promise<CentralActionProgress> {
    const id = requestUuid(callId);
    const result = await this.#request(
      "GET",
      `/api/action_progress?call_id=${id}`,
      undefined,
      signal,
    );
    if (
      !exactKeys(result, ["call_id", "call_status", "events"]) ||
      result.call_id !== id ||
      !["pending", "completed", "failed"].includes(result.call_status as string) ||
      !Array.isArray(result.events) ||
      result.events.length > 1000
    )
      throw failure("central_response_invalid");
    let previous = 0;
    const ids = new Set<string>();
    for (const event of result.events) {
      if (
        !exactKeys(event, ["event_id", "sequence", "state", "reported_at"], ["note"]) ||
        typeof event.event_id !== "string" ||
        !UUID.test(event.event_id) ||
        ids.has(event.event_id) ||
        !Number.isSafeInteger(event.sequence) ||
        (event.sequence as number) <= previous ||
        !["working", "waiting_for_owner_input", "failed"].includes(event.state as string) ||
        (event.note !== undefined &&
          event.note !== null &&
          (typeof event.note !== "string" || event.note.length > 200)) ||
        typeof event.reported_at !== "string" ||
        event.reported_at.length > 64 ||
        !/(Z|[+-]\d{2}:\d{2})$/u.test(event.reported_at) ||
        !Number.isFinite(Date.parse(event.reported_at))
      )
        throw failure("central_response_invalid");
      previous = event.sequence as number;
      ids.add(event.event_id);
    }
    assertNoCentralCredentialFields(result);
    safeResultSize(result);
    return result as unknown as CentralActionProgress;
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
    if (
      !exactKeys(result, ["messages"], ["has_more", "lease_seconds"]) ||
      !Array.isArray(result.messages) ||
      (result.has_more !== undefined && typeof result.has_more !== "boolean") ||
      (result.lease_seconds !== undefined &&
        (!Number.isSafeInteger(result.lease_seconds) || (result.lease_seconds as number) < 0))
    ) {
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
      !exactKeys(result, ["message_id", "status", "acknowledged", "already_acked", "unknown"]) ||
      result.message_id !== messageId ||
      result.status !== "acked" ||
      !Array.isArray(result.acknowledged) ||
      result.acknowledged.length !== 1 ||
      result.acknowledged[0] !== messageId ||
      !Array.isArray(result.already_acked) ||
      result.already_acked.length > 1 ||
      result.already_acked.some((id) => id !== messageId) ||
      !Array.isArray(result.unknown) ||
      result.unknown.length !== 0
    ) {
      throw failure("central_response_invalid");
    }
    return { message_id: messageId, status: "acked" };
  }

  async releaseMessages(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    if (ids.length < 1 || ids.length > 256) throw failure("invalid_arguments");
    const requested = [...new Set(ids.map(requestUuid))];
    const result = await this.#request(
      "POST",
      "/api/release_messages",
      { message_ids: requested },
      signal,
    );
    if (
      !exactKeys(result, ["released"]) ||
      !Array.isArray(result.released) ||
      result.released.length > requested.length ||
      new Set(result.released).size !== result.released.length ||
      result.released.some((id) => !requested.includes(id))
    )
      throw failure("central_response_invalid");
  }

  async resumeMutation(
    operation: CentralMutation,
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const body = this.#mutations?.body(operation, key);
    if (body === undefined) return undefined;
    switch (operation) {
      case "request_permission":
        return this.requestPermission(body, signal, key);
      case "call_action":
        return this.callAction(body, signal, key);
      case "submit_action_result":
        return this.submitActionResult(body, signal, key);
      case "get_human_input":
        return this.requestHumanInput(body as unknown as CentralHumanInputRequest, signal, key);
    }
  }

  async #lookupMutation(
    operation: CentralMutation,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt | undefined> {
    const query = new URLSearchParams({ operation, idempotency_key: key });
    const result = await this.#request(
      "GET",
      `/api/idempotency_status?${query}`,
      undefined,
      signal,
    );
    if (
      !exactKeys(result, [
        "operation",
        "idempotency_key",
        "found",
        "state",
        "status_code",
        "response",
        "message",
      ]) ||
      result.operation !== operation ||
      result.idempotency_key !== key ||
      typeof result.found !== "boolean" ||
      !["accepted", "rejected", "unknown"].includes(String(result.state)) ||
      typeof result.message !== "string" ||
      result.message.length > 2000
    )
      throw failure("central_response_invalid");
    if (result.state === "unknown") {
      if (result.status_code !== null || result.response !== null)
        throw failure("central_response_invalid");
      // The same key is safe to retry, including after the server's in-progress lease expires.
      return undefined;
    }
    if (
      !result.found ||
      !Number.isInteger(result.status_code) ||
      !isCentralRecord(result.response) ||
      (result.state === "accepted"
        ? (result.status_code as number) < 200 || (result.status_code as number) >= 300
        : (result.status_code as number) < 400 || (result.status_code as number) >= 500)
    )
      throw failure("central_response_invalid");
    return { status: result.status_code as number, body: result.response };
  }

  async #request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    deadlineMs?: number,
    requestKey?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      await this.#beforeRequest?.(signal);
      const send = () =>
        this.#transport.fetch(
          new URL(path, this.#origin),
          {
            method,
            ...(body === undefined
              ? {}
              : {
                  headers: {
                    "content-type": "application/json",
                    ...(requestKey === undefined ? {} : { "Idempotency-Key": requestKey }),
                  },
                  body: JSON.stringify(body),
                }),
            ...(signal === undefined ? {} : { signal }),
          },
          deadlineMs,
        );
      if (requestKey !== undefined && body !== undefined && this.#mutations !== undefined) {
        const operation = path.slice("/api/".length) as CentralMutation;
        const receipt = await this.#mutations.execute(
          operation,
          requestKey,
          body,
          async () => {
            const wire = await send();
            const content = await readCentralJson(wire);
            if (!isCentralRecord(content)) throw failure("central_response_invalid");
            assertNoCentralCredentialFields(content);
            return { status: wire.status, body: content };
          },
          () => this.#lookupMutation(operation, requestKey, signal),
        );
        response = Response.json(receipt.body, { status: receipt.status });
      } else response = await send();
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
      if (
        response.status === 403 &&
        isCentralRecord(rejection) &&
        isCentralRecord(rejection.detail) &&
        rejection.detail.error === "Not the execution device for this agent" &&
        ["executor_revoked", "executor_transferred", "execution_token_required"].includes(
          String(rejection.detail.reason),
        )
      )
        throw new CentralRestError("executor_inactive", {
          httpStatus: response.status,
          notAccepted: true,
        });
      if (
        path === "/api/request_permission" &&
        response.status === 403 &&
        isCentralRecord(rejection) &&
        typeof rejection.detail === "string" &&
        /^Agent '[^'\n]{1,254}' does not accept permission requests for '[^'\n]{1,128}'\. Call GET \/api\/available_actions\?agent_email=/u.test(
          rejection.detail,
        )
      )
        throw new CentralRestError("action_not_accepted", { httpStatus: 403, notAccepted: true });
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
                "Permission is revoked, not granted": "permission_revoked",
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
          notAccepted:
            rejectedStatuses.includes(response.status) &&
            !(requestKey !== undefined && response.status === 409),
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
