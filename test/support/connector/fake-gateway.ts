import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 262_144;
const MAX_POLL_MESSAGES = 100;
const MAX_POLL_RESULT_BYTES = 524_288;
const URI_UNRESERVED_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const WEBHOOK_TOKEN = /^[0-9a-f]{48}$/u;
const PROTOCOL_VERSION = "2025-06-18";

export const CONNECTOR_WAKE_DEADLINE_MS = 10_000;

export const CONNECTOR_DELIVERY_TOOLS = [
  "poll_messages",
  "reply_message",
  "complete_message",
  "get_message_outcome",
  "ack_message",
] as const;

export type ConnectorDeliveryTool = (typeof CONNECTOR_DELIVERY_TOOLS)[number];

export interface FakeGatewayMessage {
  id: string;
  conversation_id: string;
  sender_agent_id: string;
  message_type: "conversation_turn";
  in_reply_to_message_id: string | null;
  payload: { text: string };
  created_at: string;
}

export interface FakeGatewayCall {
  name: ConnectorDeliveryTool;
  arguments: Record<string, unknown>;
}

interface MessageRecord {
  messageId: string;
  conversationId: string;
  message: FakeGatewayMessage | undefined;
  terminal:
    | {
        kind: "reply";
        replyMessageId: string;
        text: string | undefined;
        fingerprint: string;
      }
    | { kind: "completion"; outcome: CompletionOutcome; reasonCode: CompletionReason }
    | undefined;
  acknowledged: boolean;
}

type CompletionOutcome =
  | "completed_without_reply"
  | "unsupported"
  | "failed"
  | "cancelled"
  | "uncertain";

type CompletionReason =
  | "no_reply_required"
  | "unsupported_message_type"
  | "unsupported_payload"
  | "provider_start_failed"
  | "provider_execution_failed"
  | "provider_result_invalid"
  | "cancelled_before_execution"
  | "cancelled_during_safe_wait"
  | "provider_outcome_unknown";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface WakeOptions {
  timestampSeconds?: number;
  signal?: AbortSignal;
}

export interface FakeGatewayTombstone {
  message_id: string;
  conversation_id: string;
  outcome: string;
  reply_message_id: string | null;
  acknowledged: true;
}

export interface FakeConnectorGateway {
  readonly endpoint: string;
  readonly token: string;
  readonly calls: readonly FakeGatewayCall[];
  readonly rejectedBeforeBodyCount: number;
  readonly pollResultBytes: number;
  readonly rawContentBytes: number;
  enqueueMessage(message: FakeGatewayMessage): void;
  setNextPollResultForTest(result: Readonly<Record<string, unknown>>): void;
  tombstone(messageId: string): FakeGatewayTombstone | undefined;
  sendWake(webhookUrl: string, messageId: string, options?: WakeOptions): Promise<Response>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && URI_UNRESERVED_ID.test(value);
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
    Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES
  );
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(actual: string | undefined, token: string): boolean {
  return timingSafeEqual(hash(actual ?? ""), hash(`Bearer ${token}`));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateMessage(message: FakeGatewayMessage): void {
  assert.ok(
    exactKeys(message as unknown as Record<string, unknown>, [
      "id",
      "conversation_id",
      "sender_agent_id",
      "message_type",
      "in_reply_to_message_id",
      "payload",
      "created_at",
    ]),
    "fake gateway message must use the exact version 2 shape",
  );
  assert.ok(validId(message.id));
  assert.ok(validId(message.conversation_id));
  assert.ok(validId(message.sender_agent_id));
  assert.equal(message.message_type, "conversation_turn");
  assert.ok(message.in_reply_to_message_id === null || validId(message.in_reply_to_message_id));
  assert.ok(exactKeys(message.payload as Record<string, unknown>, ["text"]));
  assert.ok(validText(message.payload.text));
  assert.match(message.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(new Date(message.created_at).toISOString(), message.created_at);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_MCP_BODY_BYTES) {
        settled = true;
        request.pause();
        reject(new Error("fixture_mcp_body_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("fixture_mcp_body_invalid"));
      }
    });
    request.once("aborted", () => reject(new Error("fixture_mcp_body_aborted")));
    request.once("error", () => reject(new Error("fixture_mcp_body_failed")));
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json",
  });
  response.end(bytes);
}

function result(id: unknown, value: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

function failure(id: unknown, code: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_000, message: "fixture_tool_error", data: { code } },
  };
}

function tool(
  name: ConnectorDeliveryTool,
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    name,
    description: `${name} connector fixture tool`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._~-]+$",
};

const TEXT_SCHEMA = { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES };

const COMPLETION_OUTCOMES = [
  "completed_without_reply",
  "unsupported",
  "failed",
  "cancelled",
  "uncertain",
] as const;

const COMPLETION_REASON_CODES = [
  "no_reply_required",
  "unsupported_message_type",
  "unsupported_payload",
  "provider_start_failed",
  "provider_execution_failed",
  "provider_result_invalid",
  "cancelled_before_execution",
  "cancelled_during_safe_wait",
  "provider_outcome_unknown",
] as const;

export const CONNECTOR_DELIVERY_TOOL_DEFINITIONS = [
  tool("poll_messages", { timeout: { type: "integer", minimum: 0, maximum: 30 } }, ["timeout"]),
  tool(
    "reply_message",
    {
      message_id: ID_SCHEMA,
      payload: {
        type: "object",
        properties: { text: TEXT_SCHEMA },
        required: ["text"],
        additionalProperties: false,
      },
    },
    ["message_id", "payload"],
  ),
  tool(
    "complete_message",
    {
      message_id: ID_SCHEMA,
      outcome: { type: "string", enum: COMPLETION_OUTCOMES },
      reason_code: { type: "string", enum: COMPLETION_REASON_CODES },
    },
    ["message_id", "outcome", "reason_code"],
  ),
  tool("get_message_outcome", { message_id: ID_SCHEMA }, ["message_id"]),
  tool("ack_message", { message_id: ID_SCHEMA }, ["message_id"]),
];

const COMPLETION_REASONS: Readonly<Record<CompletionOutcome, readonly CompletionReason[]>> = {
  completed_without_reply: ["no_reply_required"],
  unsupported: ["unsupported_message_type", "unsupported_payload"],
  failed: ["provider_start_failed", "provider_execution_failed", "provider_result_invalid"],
  cancelled: ["cancelled_before_execution", "cancelled_during_safe_wait"],
  uncertain: ["provider_outcome_unknown"],
};

function parseCall(request: JsonRpcRequest): { name: string; arguments: Record<string, unknown> } {
  if (!isObject(request.params)) throw new Error("invalid_request");
  const name = request.params.name;
  const arguments_ = request.params.arguments;
  if (typeof name !== "string" || !isObject(arguments_)) throw new Error("invalid_request");
  return { name, arguments: arguments_ };
}

class GatewayFixture implements FakeConnectorGateway {
  readonly #server: Server;
  readonly #records = new Map<string, MessageRecord>();
  readonly #callRecords: FakeGatewayCall[] = [];
  readonly #pollResultOverrides: Readonly<Record<string, unknown>>[] = [];
  readonly #sessionId = "connector-fixture-session";
  #endpoint: string | undefined;
  #accepting = false;
  #rejectedBeforeBodyCount = 0;
  #nextReply = 1;

  constructor(
    readonly token: string,
    private readonly port: number,
  ) {
    assert.match(token, WEBHOOK_TOKEN);
    assert.ok(Number.isInteger(port) && port >= 0 && port <= 65_535);
    this.#server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
      void this.#handle(request, response);
    });
  }

  get endpoint(): string {
    if (this.#endpoint === undefined) throw new Error("fake gateway is not listening");
    return this.#endpoint;
  }

  get calls(): readonly FakeGatewayCall[] {
    return this.#callRecords.map((call) => clone(call));
  }

  get rejectedBeforeBodyCount(): number {
    return this.#rejectedBeforeBodyCount;
  }

  get pollResultBytes(): number {
    return Buffer.byteLength(JSON.stringify({ messages: this.#activeMessages() }), "utf8");
  }

  get rawContentBytes(): number {
    let bytes = 0;
    for (const record of this.#records.values()) {
      if (record.message !== undefined) {
        bytes += Buffer.byteLength(record.message.payload.text, "utf8");
      }
      if (record.terminal?.kind === "reply" && record.terminal.text !== undefined) {
        bytes += Buffer.byteLength(record.terminal.text, "utf8");
      }
    }
    return bytes;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => reject(new Error("fake gateway failed to bind"));
      this.#server.once("error", fail);
      this.#server.listen(this.port, "127.0.0.1", () => {
        this.#server.off("error", fail);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo;
    this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.#accepting = true;
  }

  enqueueMessage(message: FakeGatewayMessage): void {
    validateMessage(message);
    assert.ok(!this.#records.has(message.id), "fake gateway message ID already exists");
    const messages = [...this.#activeMessages(), clone(message)];
    assert.ok(messages.length <= MAX_POLL_MESSAGES, "fake gateway message capacity reached");
    assert.ok(
      Buffer.byteLength(JSON.stringify({ messages }), "utf8") <= MAX_POLL_RESULT_BYTES,
      "fake gateway poll result capacity reached",
    );
    this.#records.set(message.id, {
      messageId: message.id,
      conversationId: message.conversation_id,
      message: clone(message),
      terminal: undefined,
      acknowledged: false,
    });
  }

  setNextPollResultForTest(result: Readonly<Record<string, unknown>>): void {
    this.#pollResultOverrides.push(clone(result));
  }

  tombstone(messageId: string): FakeGatewayTombstone | undefined {
    const record = this.#records.get(messageId);
    if (record === undefined || !record.acknowledged || record.terminal === undefined) {
      return undefined;
    }
    return {
      message_id: record.messageId,
      conversation_id: record.conversationId,
      outcome: record.terminal.kind === "reply" ? "replied" : record.terminal.outcome,
      reply_message_id: record.terminal.kind === "reply" ? record.terminal.replyMessageId : null,
      acknowledged: true,
    };
  }

  async sendWake(
    webhookUrl: string,
    messageId: string,
    options: WakeOptions = {},
  ): Promise<Response> {
    assert.ok(validId(messageId));
    const url = new URL(webhookUrl);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/webhook");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.notEqual(url.port, "");

    const body = JSON.stringify({
      message: `A2A message ${messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
      name: "A2A Gateway",
      deliver: false,
      wakeMode: "now",
    });
    const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1_000));
    const signature = createHmac("sha256", this.token)
      .update(timestamp, "ascii")
      .update(".", "ascii")
      .update(body, "utf8")
      .digest("hex");
    return await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "idempotency-key": messageId,
        "x-request-id": messageId,
        "x-webhook-signature-v2": signature,
        "x-webhook-timestamp": timestamp,
      },
      body,
      redirect: "manual",
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(CONNECTOR_WAKE_DEADLINE_MS)
          : AbortSignal.any([options.signal, AbortSignal.timeout(CONNECTOR_WAKE_DEADLINE_MS)]),
    });
  }

  async close(): Promise<void> {
    this.#accepting = false;
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#accepting) {
      sendJson(response, 503, { error: "fixture_unavailable" });
      return;
    }
    if (request.url !== "/mcp") {
      sendJson(response, 404, { error: "fixture_path_not_found" });
      return;
    }
    const address = this.#server.address() as AddressInfo;
    if (request.headers.host !== `127.0.0.1:${address.port}`) {
      sendJson(response, 421, { error: "fixture_host_rejected" });
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${address.port}`) {
      sendJson(response, 403, { error: "fixture_origin_rejected" });
      return;
    }
    if (!authorized(request.headers.authorization, this.token)) {
      this.#rejectedBeforeBodyCount += 1;
      sendJson(response, 401, { error: "fixture_auth_failed" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "fixture_method_rejected" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = await readBody(request);
    } catch {
      sendJson(response, 400, { error: "fixture_request_invalid" });
      return;
    }
    if (!isObject(parsed) || Array.isArray(parsed)) {
      sendJson(response, 400, { error: "fixture_request_invalid" });
      return;
    }
    const rpc = parsed as JsonRpcRequest;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      sendJson(response, 400, { error: "fixture_request_invalid" });
      return;
    }
    if (rpc.method === "initialize") {
      response.setHeader("mcp-session-id", this.#sessionId);
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "a2a-connector-gateway-fixture", version: "1" },
        },
      });
      return;
    }
    const session = request.headers["mcp-session-id"];
    if (session !== this.#sessionId) {
      sendJson(response, 400, { error: "fixture_session_invalid" });
      return;
    }
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (rpc.method === "tools/list") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { tools: CONNECTOR_DELIVERY_TOOL_DEFINITIONS },
      });
      return;
    }
    if (rpc.method !== "tools/call") {
      sendJson(response, 200, failure(rpc.id, "invalid_request"));
      return;
    }

    try {
      const call = parseCall(rpc);
      const value = this.#callTool(call.name, call.arguments);
      sendJson(response, 200, result(rpc.id, value));
    } catch (error) {
      const code = error instanceof Error ? error.message : "fixture_internal_error";
      sendJson(response, 200, failure(rpc.id, code));
    }
  }

  #callTool(name: string, arguments_: Record<string, unknown>): Record<string, unknown> {
    if (!CONNECTOR_DELIVERY_TOOLS.includes(name as ConnectorDeliveryTool)) {
      throw new Error("invalid_request");
    }
    const toolName = name as ConnectorDeliveryTool;
    this.#callRecords.push({
      name: toolName,
      arguments:
        toolName === "reply_message" && isObject(arguments_.payload)
          ? {
              message_id: arguments_.message_id,
              payload_text_bytes:
                typeof arguments_.payload.text === "string"
                  ? Buffer.byteLength(arguments_.payload.text, "utf8")
                  : null,
            }
          : clone(arguments_),
    });
    if (toolName === "poll_messages") return this.#poll(arguments_);
    if (toolName === "reply_message") return this.#reply(arguments_);
    if (toolName === "complete_message") return this.#complete(arguments_);
    if (toolName === "get_message_outcome") return this.#outcome(arguments_);
    return this.#ack(arguments_);
  }

  #poll(arguments_: Record<string, unknown>): Record<string, unknown> {
    if (
      !exactKeys(arguments_, ["timeout"]) ||
      !Number.isInteger(arguments_.timeout) ||
      (arguments_.timeout as number) < 0 ||
      (arguments_.timeout as number) > 30
    ) {
      throw new Error("invalid_request");
    }
    const override = this.#pollResultOverrides.shift();
    if (override !== undefined) return clone(override);
    return { messages: this.#activeMessages() };
  }

  #activeMessages(): FakeGatewayMessage[] {
    return [...this.#records.values()].flatMap((record) =>
      record.message === undefined ? [] : [clone(record.message)],
    );
  }

  #record(arguments_: Record<string, unknown>, keys: readonly string[]): MessageRecord {
    if (!exactKeys(arguments_, keys) || !validId(arguments_.message_id)) {
      throw new Error("invalid_request");
    }
    const record = this.#records.get(arguments_.message_id);
    if (record === undefined) throw new Error("message_not_found");
    return record;
  }

  #reply(arguments_: Record<string, unknown>): Record<string, unknown> {
    const record = this.#record(arguments_, ["message_id", "payload"]);
    if (!isObject(arguments_.payload) || !exactKeys(arguments_.payload, ["text"])) {
      throw new Error("invalid_request");
    }
    const text = arguments_.payload.text;
    if (!validText(text)) throw new Error("invalid_request");
    if (record.terminal?.kind === "completion") throw new Error("message_already_terminal");
    if (record.terminal?.kind === "reply") {
      if (record.terminal.fingerprint !== this.#replyFingerprint(text)) {
        throw new Error("idempotency_conflict");
      }
      return {
        message_id: record.terminal.replyMessageId,
        conversation_id: record.conversationId,
        status: "accepted",
      };
    }
    const replyMessageId = `fixture_reply_${this.#nextReply}`;
    this.#nextReply += 1;
    record.terminal = {
      kind: "reply",
      replyMessageId,
      text,
      fingerprint: this.#replyFingerprint(text),
    };
    return {
      message_id: replyMessageId,
      conversation_id: record.conversationId,
      status: "accepted",
    };
  }

  #replyFingerprint(text: string): string {
    return createHmac("sha256", this.token).update(text, "utf8").digest("hex");
  }

  #complete(arguments_: Record<string, unknown>): Record<string, unknown> {
    const record = this.#record(arguments_, ["message_id", "outcome", "reason_code"]);
    const outcome = arguments_.outcome;
    const reasonCode = arguments_.reason_code;
    if (
      typeof outcome !== "string" ||
      !(outcome in COMPLETION_REASONS) ||
      typeof reasonCode !== "string" ||
      !COMPLETION_REASONS[outcome as CompletionOutcome].includes(reasonCode as CompletionReason)
    ) {
      throw new Error("invalid_request");
    }
    if (record.terminal?.kind === "reply") throw new Error("message_already_terminal");
    if (record.terminal?.kind === "completion") {
      if (record.terminal.outcome !== outcome || record.terminal.reasonCode !== reasonCode) {
        throw new Error("idempotency_conflict");
      }
    } else {
      record.terminal = {
        kind: "completion",
        outcome: outcome as CompletionOutcome,
        reasonCode: reasonCode as CompletionReason,
      };
    }
    return { message_id: record.messageId, outcome, status: "recorded" };
  }

  #outcome(arguments_: Record<string, unknown>): Record<string, unknown> {
    const record = this.#record(arguments_, ["message_id"]);
    if (record.terminal === undefined) {
      return {
        message_id: record.messageId,
        conversation_id: record.conversationId,
        status: "open",
        outcome: null,
        reply_message_id: null,
      };
    }
    return {
      message_id: record.messageId,
      conversation_id: record.conversationId,
      status: "terminal",
      outcome: record.terminal.kind === "reply" ? "replied" : record.terminal.outcome,
      reply_message_id: record.terminal.kind === "reply" ? record.terminal.replyMessageId : null,
    };
  }

  #ack(arguments_: Record<string, unknown>): Record<string, unknown> {
    const record = this.#record(arguments_, ["message_id"]);
    if (record.terminal === undefined) throw new Error("message_not_terminal");
    record.acknowledged = true;
    record.message = undefined;
    if (record.terminal.kind === "reply") record.terminal.text = undefined;
    return { message_id: record.messageId, status: "acked" };
  }
}

export async function startFakeConnectorGateway(
  t: TestContext,
  options: { token?: string; port?: number } = {},
): Promise<FakeConnectorGateway> {
  const fixture = new GatewayFixture(
    options.token ?? "0123456789abcdef0123456789abcdef0123456789abcdef",
    options.port ?? 0,
  );
  await fixture.listen();
  t.after(async () => fixture.close());
  return fixture;
}
