import { createHash } from "node:crypto";
import type { CentralProtectedTransport } from "./central-protected-transport.js";
import { CentralProtectedTransportError } from "./central-protected-transport.js";
import { assertSafeUpstreamResult, type CentralToolDefinition } from "./mcp-contract.js";

const RESPONSE_HEADERS_MAX_BYTES = 16 * 1024;
const RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;
const RECEIVE_RESULT_MAX_BYTES = 524_288;
const RESPONSE_MAX_DEPTH = 100;
const RESPONSE_MAX_STRUCTURAL_TOKENS = 16_384;
const RESPONSE_MAX_MEMBERS = 1_024;
const RESPONSE_MAX_ELEMENTS = 128;
const MESSAGE_TEXT_MAX_BYTES = 262_144;
const REQUEST_BODY_MAX_BYTES = 524_288;
const ACTIVATION_RETRY_DELAY_MS = 1_000;
const SAFE_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const URI_UNRESERVED_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_MILLISECONDS =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

const APPLICATION_STATUS = new Map<string, readonly number[]>([
  ["invalid_request", [400]],
  ["recipient_unavailable", [404]],
  ["message_not_found", [404]],
  ["idempotency_conflict", [409]],
  ["message_already_terminal", [409]],
  ["message_not_terminal", [409]],
  ["receive_in_progress", [409]],
  ["protocol_mismatch", [409]],
  ["migration_incomplete", [409]],
  ["request_too_large", [413]],
  ["mailbox_full", [429]],
  ["rate_limited", [429]],
  ["temporarily_unavailable", [503]],
]);

const COMPLETION_REASONS: Readonly<Record<string, readonly string[]>> = {
  completed_without_reply: ["no_reply_required"],
  unsupported: ["unsupported_message_type", "unsupported_payload"],
  failed: ["provider_start_failed", "provider_execution_failed", "provider_result_invalid"],
  cancelled: ["cancelled_before_execution", "cancelled_during_safe_wait"],
  uncertain: ["provider_outcome_unknown"],
};

export type ConversationApplicationErrorCode =
  | "idempotency_conflict"
  | "invalid_request"
  | "mailbox_full"
  | "message_already_terminal"
  | "message_not_found"
  | "message_not_terminal"
  | "migration_incomplete"
  | "protocol_mismatch"
  | "rate_limited"
  | "receive_in_progress"
  | "recipient_unavailable"
  | "request_too_large"
  | "temporarily_unavailable";

export type CentralConversationErrorCode =
  | ConversationApplicationErrorCode
  | "central_conversation_contract_failed"
  | "central_conversation_outcome_uncertain";

export class CentralConversationError extends Error {
  constructor(
    readonly code: CentralConversationErrorCode,
    readonly retryAfterMs?: number | null,
    readonly authenticationFailure = false,
  ) {
    super("Central conversation operation failed");
    this.name = "CentralConversationError";
  }

  get applicationError(): boolean {
    return APPLICATION_STATUS.has(this.code);
  }
}

class ConversationContractError extends Error {}
class ResponseTooLarge extends ConversationContractError {}

export interface ConversationMessage extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly conversation_id: string;
  readonly sender_agent_id: string;
  readonly message_type: "conversation_turn";
  readonly in_reply_to_message_id: string | null;
  readonly payload: { readonly text: string };
  readonly created_at: string;
}

export interface CentralConversationClientOptions {
  readonly centralApiUrl: string | URL;
  readonly transport: CentralProtectedTransport;
  readonly receiveTransport: CentralProtectedTransport;
}

interface RequestSpec {
  readonly method: "GET" | "POST";
  readonly pathname: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectedStatus: readonly number[];
  readonly responseLimit?: number;
  readonly transport?: CentralProtectedTransport;
  readonly inspectCredential?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !hasLoneSurrogate(value) &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= MESSAGE_TEXT_MAX_BYTES
  );
}

function validUsername(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || hasLoneSurrogate(value)) return false;
  const characters = [...value].length;
  if (characters < 3 || characters > 50 || Buffer.byteLength(value, "utf8") > 200) return false;
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && URI_UNRESERVED_ID.test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function waitForActivationRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (retry: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(retry);
    };
    const abort = (): void => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function payload(value: unknown): { readonly text: string } | undefined {
  if (!isObject(value) || !exactKeys(value, ["text"]) || !validText(value.text)) return undefined;
  return { text: value.text };
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ConversationContractError();
  return value;
}

export function validateStartConversationArguments(value: unknown): {
  readonly recipient_username: string;
  readonly payload: { readonly text: string };
  readonly request_id: string;
} {
  const input = inputObject(value);
  const body = payload(input.payload);
  if (
    !exactKeys(input, ["recipient_username", "payload", "request_id"]) ||
    !validUsername(input.recipient_username) ||
    body === undefined ||
    !validRequestId(input.request_id)
  ) {
    throw new ConversationContractError();
  }
  return {
    recipient_username: input.recipient_username,
    payload: body,
    request_id: input.request_id,
  };
}

export function validateRequestIdArguments(value: unknown): { readonly request_id: string } {
  const input = inputObject(value);
  if (!exactKeys(input, ["request_id"]) || !validRequestId(input.request_id)) {
    throw new ConversationContractError();
  }
  return { request_id: input.request_id };
}

export function validateReplyArguments(value: unknown): {
  readonly message_id: string;
  readonly payload: { readonly text: string };
} {
  const input = inputObject(value);
  const body = payload(input.payload);
  if (
    !exactKeys(input, ["message_id", "payload"]) ||
    !validIdentifier(input.message_id) ||
    body === undefined
  ) {
    throw new ConversationContractError();
  }
  return { message_id: input.message_id, payload: body };
}

export function validateCompletionArguments(value: unknown): {
  readonly message_id: string;
  readonly outcome: string;
  readonly reason_code: string;
} {
  const input = inputObject(value);
  if (
    !exactKeys(input, ["message_id", "outcome", "reason_code"]) ||
    !validIdentifier(input.message_id) ||
    typeof input.outcome !== "string" ||
    typeof input.reason_code !== "string" ||
    !COMPLETION_REASONS[input.outcome]?.includes(input.reason_code)
  ) {
    throw new ConversationContractError();
  }
  return {
    message_id: input.message_id,
    outcome: input.outcome,
    reason_code: input.reason_code,
  };
}

export function validateMessageIdArguments(value: unknown): { readonly message_id: string } {
  const input = inputObject(value);
  if (!exactKeys(input, ["message_id"]) || !validIdentifier(input.message_id)) {
    throw new ConversationContractError();
  }
  return { message_id: input.message_id };
}

class StrictConversationJsonParser {
  #index = 0;
  #members = 0;
  #elements = 0;
  #structuralTokens = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length) this.#invalid();
    return value;
  }

  #value(depth: number): unknown {
    this.#whitespace();
    const character = this.text[this.#index];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    if (this.text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #object(depth: number): Record<string, unknown> {
    this.#container(depth);
    this.#index += 1;
    this.#whitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const names = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.#index] !== '"') this.#invalid();
      const name = this.#string();
      if (names.has(name)) this.#invalid();
      names.add(name);
      this.#members += 1;
      if (this.#members > RESPONSE_MAX_MEMBERS) this.#invalid();
      this.#whitespace();
      if (this.text[this.#index] !== ":") this.#invalid();
      this.#index += 1;
      result[name] = this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.#invalid();
      this.#index += 1;
      this.#whitespace();
    }
  }

  #array(depth: number): unknown[] {
    this.#container(depth);
    this.#index += 1;
    this.#whitespace();
    const result: unknown[] = [];
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value(depth));
      this.#elements += 1;
      if (this.#elements > RESPONSE_MAX_ELEMENTS) this.#invalid();
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.#invalid();
      this.#index += 1;
      this.#whitespace();
    }
  }

  #container(depth: number): void {
    this.#structuralTokens += 1;
    if (depth > RESPONSE_MAX_DEPTH || this.#structuralTokens > RESPONSE_MAX_STRUCTURAL_TOKENS) {
      this.#invalid();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      this.#index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(this.text.slice(start, this.#index));
        } catch {
          return this.#invalid();
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) this.#invalid();
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) this.#invalid();
    }
    return this.#invalid();
  }

  #number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.#index;
    const parsed = match.exec(this.text);
    if (parsed === null) this.#invalid();
    this.#index = match.lastIndex;
    const value = Number(parsed[0]);
    if (!Number.isFinite(value)) this.#invalid();
    return value;
  }

  #whitespace(): void {
    while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.#index))) this.#index += 1;
  }

  #invalid(): never {
    throw new ConversationContractError();
  }
}

function parseStrictJson(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConversationContractError();
  }
  const value = new StrictConversationJsonParser(text).parse();
  if (!isObject(value)) throw new ConversationContractError();
  return value;
}

function approximateHeaderBytes(headers: Headers): number {
  let total = 2;
  for (const [name, value] of headers) {
    total += Buffer.byteLength(name, "latin1") + 2 + Buffer.byteLength(value, "latin1") + 2;
  }
  return total;
}

function hasNoStore(headers: Headers): boolean {
  return (
    headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") === true
  );
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function assertSafeResponseHead(response: Response): void {
  const mediaType = response.headers.get("content-type");
  if (
    approximateHeaderBytes(response.headers) > RESPONSE_HEADERS_MAX_BYTES ||
    response.headers.has("set-cookie") ||
    response.headers.has("content-encoding") ||
    !hasNoStore(response.headers) ||
    mediaType === null ||
    !SAFE_MEDIA_TYPE.test(mediaType)
  ) {
    throw new ConversationContractError();
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await cancelBody(response);
    throw new ResponseTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLarge();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ResponseTooLarge) throw error;
    throw new CentralConversationError("central_conversation_outcome_uncertain");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function applicationError(
  response: Response,
  value: Record<string, unknown>,
): CentralConversationError {
  if (!exactKeys(value, ["error"]) || !isObject(value.error)) {
    throw new ConversationContractError();
  }
  const error = value.error;
  if (
    !exactKeys(error, ["code", "retry_after_ms"]) ||
    typeof error.code !== "string" ||
    !APPLICATION_STATUS.get(error.code)?.includes(response.status)
  ) {
    throw new ConversationContractError();
  }
  if (error.code === "rate_limited") {
    if (
      typeof error.retry_after_ms !== "number" ||
      !Number.isInteger(error.retry_after_ms) ||
      error.retry_after_ms < 1 ||
      error.retry_after_ms > 60_000 ||
      response.headers.get("retry-after") !==
        String(Math.max(1, Math.ceil(error.retry_after_ms / 1_000)))
    ) {
      throw new ConversationContractError();
    }
    return new CentralConversationError(error.code, error.retry_after_ms);
  }
  if (error.retry_after_ms !== null || response.headers.has("retry-after")) {
    throw new ConversationContractError();
  }
  return new CentralConversationError(error.code as ConversationApplicationErrorCode, null);
}

function message(value: unknown): ConversationMessage {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "id",
      "conversation_id",
      "sender_agent_id",
      "message_type",
      "in_reply_to_message_id",
      "payload",
      "created_at",
    ])
  ) {
    throw new ConversationContractError();
  }
  const body = payload(value.payload);
  if (
    !validIdentifier(value.id) ||
    !validIdentifier(value.conversation_id) ||
    !validIdentifier(value.sender_agent_id) ||
    value.message_type !== "conversation_turn" ||
    (value.in_reply_to_message_id !== null && !validIdentifier(value.in_reply_to_message_id)) ||
    value.in_reply_to_message_id === value.id ||
    body === undefined ||
    typeof value.created_at !== "string" ||
    !UTC_MILLISECONDS.test(value.created_at) ||
    Number.isNaN(Date.parse(value.created_at)) ||
    new Date(value.created_at).toISOString() !== value.created_at
  ) {
    throw new ConversationContractError();
  }
  return {
    id: value.id,
    conversation_id: value.conversation_id,
    sender_agent_id: value.sender_agent_id,
    message_type: "conversation_turn",
    in_reply_to_message_id: value.in_reply_to_message_id,
    payload: body,
    created_at: value.created_at,
  };
}

function acceptedResult(value: Record<string, unknown>): Record<string, unknown> {
  if (
    !exactKeys(value, ["message_id", "conversation_id", "status"]) ||
    !validIdentifier(value.message_id) ||
    !validIdentifier(value.conversation_id) ||
    value.status !== "accepted"
  ) {
    throw new ConversationContractError();
  }
  return value;
}

export const VERSION_TWO_LOCAL_TOOLS: readonly CentralToolDefinition[] = [
  {
    name: "start_conversation",
    description: "Start a version 2 conversation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recipient_username: { type: "string", minLength: 3, maxLength: 50 },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
        },
        request_id: { type: "string", pattern: UUID_V4.source },
      },
      required: ["recipient_username", "payload", "request_id"],
    },
  },
  {
    name: "get_conversation_start",
    description: "Resolve a version 2 conversation start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { request_id: { type: "string", pattern: UUID_V4.source } },
      required: ["request_id"],
    },
  },
  {
    name: "poll_messages",
    description: "Read the current transient version 2 inbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { timeout: { type: "integer", minimum: 0, maximum: 30 } },
      required: [],
    },
  },
  {
    name: "reply_message",
    description: "Reply to the current inbound turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message_id: { type: "string", pattern: URI_UNRESERVED_ID.source },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
        },
      },
      required: ["message_id", "payload"],
    },
  },
  {
    name: "complete_message",
    description: "Record a terminal outcome without a reply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message_id: { type: "string", pattern: URI_UNRESERVED_ID.source },
        outcome: { type: "string", enum: Object.keys(COMPLETION_REASONS) },
        reason_code: { type: "string" },
      },
      required: ["message_id", "outcome", "reason_code"],
    },
  },
  {
    name: "get_message_outcome",
    description: "Inspect a version 2 message outcome.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { message_id: { type: "string", pattern: URI_UNRESERVED_ID.source } },
      required: ["message_id"],
    },
  },
  {
    name: "ack_message",
    description: "Acknowledge a terminal inbound turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { message_id: { type: "string", pattern: URI_UNRESERVED_ID.source } },
      required: ["message_id"],
    },
  },
];

export class CentralConversationClient {
  readonly #apiBase: URL;
  readonly #transport: CentralProtectedTransport;
  readonly #receiveTransport: CentralProtectedTransport;

  constructor(options: CentralConversationClientOptions) {
    this.#apiBase = new URL(options.centralApiUrl);
    const loopback =
      this.#apiBase.hostname === "127.0.0.1" ||
      this.#apiBase.hostname === "[::1]" ||
      this.#apiBase.hostname === "localhost";
    if (
      (this.#apiBase.protocol !== "https:" && !(this.#apiBase.protocol === "http:" && loopback)) ||
      this.#apiBase.username !== "" ||
      this.#apiBase.password !== "" ||
      this.#apiBase.search !== "" ||
      this.#apiBase.hash !== ""
    ) {
      throw new Error("The central conversation configuration is invalid");
    }
    this.#transport = options.transport;
    this.#receiveTransport = options.receiveTransport;
  }

  async activate(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const value = await this.#request(
          {
            method: "POST",
            pathname: "/api/v2/delivery/activate",
            expectedStatus: [200],
          },
          signal,
        );
        if (
          !exactKeys(value, ["delivery_version", "status"]) ||
          value.delivery_version !== "v2" ||
          value.status !== "active"
        ) {
          throw new ConversationContractError();
        }
        return;
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof CentralConversationError &&
          (error.code === "central_conversation_outcome_uncertain" ||
            [
              "migration_incomplete",
              "protocol_mismatch",
              "rate_limited",
              "temporarily_unavailable",
            ].includes(error.code))
        ) {
          const delayMs =
            error.code === "rate_limited" &&
            error.retryAfterMs !== undefined &&
            error.retryAfterMs !== null
              ? error.retryAfterMs
              : ACTIVATION_RETRY_DELAY_MS;
          if (await waitForActivationRetry(signal, delayMs)) continue;
        }
        throw error;
      }
    }
    throw new CentralConversationError("central_conversation_outcome_uncertain");
  }

  async start(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = validateStartConversationArguments(arguments_);
    const body = JSON.stringify({
      recipient_username: input.recipient_username,
      payload: input.payload,
    });
    if (Buffer.byteLength(body, "utf8") > REQUEST_BODY_MAX_BYTES) {
      throw new ConversationContractError();
    }
    return acceptedResult(
      await this.#request(
        {
          method: "POST",
          pathname: "/api/v2/conversations",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Idempotency-Key": input.request_id,
          },
          body,
          expectedStatus: [200, 201],
        },
        signal,
      ),
    );
  }

  async getStart(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = validateRequestIdArguments(arguments_);
    const value = await this.#request(
      {
        method: "GET",
        pathname: `/api/v2/conversation-starts/${input.request_id}`,
        expectedStatus: [200],
      },
      signal,
    );
    if (
      !exactKeys(value, ["request_id", "status", "message_id", "conversation_id"]) ||
      value.request_id !== input.request_id ||
      (value.status !== "accepted" && value.status !== "not_found") ||
      (value.status === "accepted" &&
        (!validIdentifier(value.message_id) || !validIdentifier(value.conversation_id))) ||
      (value.status === "not_found" &&
        (value.message_id !== null || value.conversation_id !== null))
    ) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    return value;
  }

  async receive(signal: AbortSignal): Promise<readonly ConversationMessage[]> {
    const value = await this.#request(
      {
        method: "GET",
        pathname: "/api/v2/messages/receive?timeout=30&limit=100",
        expectedStatus: [200],
        responseLimit: RESPONSE_BODY_MAX_BYTES,
        transport: this.#receiveTransport,
        inspectCredential: true,
      },
      signal,
    );
    if (
      !exactKeys(value, ["messages"]) ||
      !Array.isArray(value.messages) ||
      value.messages.length > 100
    ) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    const messages = value.messages.map(message);
    const ids = new Set<string>();
    for (const item of messages) {
      if (ids.has(item.id))
        throw new CentralConversationError("central_conversation_contract_failed");
      ids.add(item.id);
    }
    if (Buffer.byteLength(JSON.stringify({ messages }), "utf8") > RECEIVE_RESULT_MAX_BYTES) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    return messages;
  }

  async reply(
    arguments_: unknown,
    signal: AbortSignal,
    expectedConversationId: string,
  ): Promise<Record<string, unknown>> {
    const input = validateReplyArguments(arguments_);
    if (!validIdentifier(expectedConversationId)) throw new ConversationContractError();
    const digest = createHash("sha256").update(input.message_id, "utf8").digest("base64url");
    const body = JSON.stringify({ payload: input.payload });
    if (Buffer.byteLength(body, "utf8") > REQUEST_BODY_MAX_BYTES) {
      throw new ConversationContractError();
    }
    const value = await this.#request(
      {
        method: "POST",
        pathname: `/api/v2/messages/${input.message_id}/reply`,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Idempotency-Key": `reply.v1.${digest}`,
        },
        body,
        expectedStatus: [200],
      },
      signal,
    );
    if (
      !exactKeys(value, ["message_id", "conversation_id", "status"]) ||
      !validIdentifier(value.message_id) ||
      value.message_id === input.message_id ||
      value.conversation_id !== expectedConversationId ||
      value.status !== "accepted"
    ) {
      throw new ConversationContractError();
    }
    return value;
  }

  async complete(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = validateCompletionArguments(arguments_);
    const value = await this.#request(
      {
        method: "POST",
        pathname: `/api/v2/messages/${input.message_id}/complete`,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ outcome: input.outcome, reason_code: input.reason_code }),
        expectedStatus: [200],
      },
      signal,
    );
    if (
      !exactKeys(value, ["message_id", "outcome", "status"]) ||
      value.message_id !== input.message_id ||
      value.outcome !== input.outcome ||
      value.status !== "recorded"
    ) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    return value;
  }

  async outcome(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = validateMessageIdArguments(arguments_);
    const value = await this.#request(
      {
        method: "GET",
        pathname: `/api/v2/messages/${input.message_id}/outcome`,
        expectedStatus: [200],
      },
      signal,
    );
    const terminalOutcomes = new Set(["replied", ...Object.keys(COMPLETION_REASONS)]);
    if (
      !exactKeys(value, [
        "message_id",
        "conversation_id",
        "status",
        "outcome",
        "reply_message_id",
      ]) ||
      value.message_id !== input.message_id ||
      !validIdentifier(value.conversation_id) ||
      (value.status !== "open" && value.status !== "terminal") ||
      (value.status === "open" && (value.outcome !== null || value.reply_message_id !== null)) ||
      (value.status === "terminal" &&
        (typeof value.outcome !== "string" || !terminalOutcomes.has(value.outcome))) ||
      (value.outcome === "replied" && !validIdentifier(value.reply_message_id)) ||
      (value.outcome === "replied" && value.reply_message_id === value.message_id) ||
      (value.status === "terminal" &&
        value.outcome !== "replied" &&
        value.reply_message_id !== null)
    ) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    return value;
  }

  async acknowledge(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = validateMessageIdArguments(arguments_);
    const value = await this.#request(
      {
        method: "POST",
        pathname: `/api/v2/messages/${input.message_id}/ack`,
        expectedStatus: [200],
      },
      signal,
    );
    if (
      !exactKeys(value, ["message_id", "status"]) ||
      value.message_id !== input.message_id ||
      value.status !== "acked"
    ) {
      throw new CentralConversationError("central_conversation_contract_failed");
    }
    return value;
  }

  async #request(spec: RequestSpec, signal: AbortSignal): Promise<Record<string, unknown>> {
    const target = new URL(spec.pathname, this.#apiBase);
    const transport = spec.transport ?? this.#transport;
    const init: RequestInit = {
      method: spec.method,
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      signal,
    };
    try {
      if (spec.inspectCredential === true) {
        return await transport.fetchAndInspectCredential(
          target,
          init,
          async (response, accessToken) => await this.#response(spec, response, accessToken),
        );
      }
      return await this.#response(spec, await transport.fetch(target, init));
    } catch (error) {
      if (error instanceof CentralConversationError) throw error;
      if (error instanceof CentralProtectedTransportError) {
        const authenticationFailure = [
          "central_dpop_proof_rejected",
          "central_protected_authentication_failed",
          "central_protected_credential_expired",
        ].includes(error.code);
        throw new CentralConversationError(
          error.code === "central_protected_request_failed"
            ? "central_conversation_outcome_uncertain"
            : "central_conversation_contract_failed",
          undefined,
          authenticationFailure,
        );
      }
      throw new CentralConversationError("central_conversation_outcome_uncertain");
    }
  }

  async #response(
    spec: RequestSpec,
    response: Response,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    try {
      assertSafeResponseHead(response);
      const bytes = await readBoundedBody(response, spec.responseLimit ?? RESPONSE_BODY_MAX_BYTES);
      const value = parseStrictJson(bytes);
      if (accessToken !== undefined) assertSafeUpstreamResult(value, accessToken);
      if (!spec.expectedStatus.includes(response.status)) throw applicationError(response, value);
      return value;
    } catch (error) {
      if (error instanceof CentralConversationError) throw error;
      await cancelBody(response);
      throw new CentralConversationError("central_conversation_contract_failed");
    }
  }
}
