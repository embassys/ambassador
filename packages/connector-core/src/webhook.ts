import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { CONNECTOR_LIMITS, URI_UNRESERVED_ID_PATTERN } from "./constants.js";
import type { ConnectorClock } from "./runtime-types.js";

type Admission = "accepted" | "coalesced" | "full";

interface ConnectionState {
  buffer: Buffer;
  parsed: boolean;
  responded: boolean;
  responseStarted: boolean;
  declaredLength: number | undefined;
  headers: Map<string, string> | undefined;
  requestLine: string | undefined;
  headerTimer: unknown;
  requestTimer: unknown;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  202: "Accepted",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  414: "URI Too Long",
  421: "Misdirected Request",
  431: "Request Header Fields Too Large",
  503: "Service Unavailable",
};
const DUPLICATE_FORBIDDEN = new Set([
  "host",
  "origin",
  "authorization",
  "content-type",
  "content-length",
  "idempotency-key",
  "x-request-id",
  "x-webhook-timestamp",
  "x-webhook-signature-v2",
]);
const FORBIDDEN_HEADERS = new Set([
  "transfer-encoding",
  "trailer",
  "expect",
  "upgrade",
  "te",
  "proxy-connection",
]);

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
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

function parseStrictWakeJson(body: Buffer): unknown | undefined {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  const containers: (Set<string> | undefined)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      containers.push(new Set());
      continue;
    }
    if (character === "[") {
      containers.push(undefined);
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const stringCharacter = text[index];
      if (escaped) escaped = false;
      else if (stringCharacter === "\\") escaped = true;
      else if (stringCharacter === '"') break;
      index += 1;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text.slice(start, index + 1));
    } catch {
      return undefined;
    }
    if (typeof decoded !== "string" || hasLoneSurrogate(decoded)) return undefined;

    let next = index + 1;
    while ([9, 10, 13, 32].includes(text.charCodeAt(next))) next += 1;
    if (text[next] !== ":") continue;
    const names = containers.at(-1);
    if (names === undefined || names.has(decoded)) return undefined;
    names.add(decoded);
  }
  return value;
}

function rawWakeId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join("\0") !==
    ["deliver", "message", "name", "wakeMode"].sort().join("\0")
  )
    return undefined;
  if (
    object.name !== "A2A Gateway" ||
    object.deliver !== false ||
    object.wakeMode !== "now" ||
    typeof object.message !== "string"
  )
    return undefined;
  const match =
    /^A2A message ([A-Za-z0-9._~-]{1,128}) is ready\. Use the A2A MCP tools to retrieve and process it\.$/u.exec(
      object.message,
    );
  return match?.[1];
}

export class WebhookReceiver {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #replays = new Map<string, number>();
  #parsedRequests = 0;
  #closed = false;
  #webhookUrl: string | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly clock: ConnectorClock,
    private readonly admit: (messageId: string) => Admission,
    private readonly stallResponseAfterCommit: boolean,
  ) {
    this.#server = createServer((socket) => this.#accept(socket));
  }

  get webhookUrl(): string {
    if (this.#webhookUrl === undefined) throw new Error("connector listener unavailable");
    return this.#webhookUrl;
  }
  get replayEntries(): number {
    return this.#replays.size;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.#server.once("error", fail);
      this.#server.listen(this.port, "127.0.0.1", () => {
        this.#server.off("error", fail);
        resolve();
      });
    });
    this.#webhookUrl = `http://127.0.0.1:${this.port}/webhook`;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) resolve();
      else this.#server.close(() => resolve());
    });
  }

  #accept(socket: Socket): void {
    if (this.#sockets.size >= CONNECTOR_LIMITS.acceptedWebhookSockets) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    const state: ConnectionState = {
      buffer: Buffer.alloc(0),
      parsed: false,
      responded: false,
      responseStarted: false,
      declaredLength: undefined,
      headers: undefined,
      requestLine: undefined,
      headerTimer: undefined,
      requestTimer: undefined,
    };
    state.headerTimer = this.clock.setTimer(
      () => socket.resetAndDestroy(),
      CONNECTOR_LIMITS.webhookHeaderDeadlineMs,
    );
    state.requestTimer = this.clock.setTimer(
      () => socket.resetAndDestroy(),
      CONNECTOR_LIMITS.webhookRequestDeadlineMs,
    );
    socket.on("data", (chunk: Buffer) => this.#data(socket, state, chunk));
    socket.once("end", () => {
      if (state.parsed && !state.responded)
        this.#respond(socket, state, 400, "connector_framing_invalid");
    });
    socket.once("close", () => {
      this.clock.clearTimer(state.headerTimer);
      this.clock.clearTimer(state.requestTimer);
      if (state.parsed) this.#parsedRequests -= 1;
      this.#sockets.delete(socket);
    });
    socket.once("error", () => socket.destroy());
  }

  #data(socket: Socket, state: ConnectionState, chunk: Buffer): void {
    if (state.responded) {
      socket.destroy();
      return;
    }
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (!state.parsed) {
      const lineEnd = state.buffer.indexOf("\r\n");
      if (lineEnd < 0) {
        if (state.buffer.includes(0x0a) || state.buffer.includes(0x0d))
          this.#respond(socket, state, 400, "connector_framing_invalid");
        else if (state.buffer.byteLength > CONNECTOR_LIMITS.webhookRequestLineBytes)
          this.#respond(socket, state, 414, "connector_request_line_too_large");
        return;
      }
      if (lineEnd > CONNECTOR_LIMITS.webhookRequestLineBytes) {
        this.#respond(socket, state, 414, "connector_request_line_too_large");
        return;
      }
      const headerEnd = state.buffer.indexOf("\r\n\r\n", lineEnd + 2);
      if (headerEnd < 0) {
        const blockBytes = state.buffer.byteLength - lineEnd - 2;
        if (blockBytes > CONNECTOR_LIMITS.webhookHeaderBytes)
          this.#respond(socket, state, 431, "connector_headers_too_large");
        return;
      }
      const headerBytes = headerEnd + 4 - lineEnd - 2;
      if (headerBytes > CONNECTOR_LIMITS.webhookHeaderBytes) {
        this.#respond(socket, state, 431, "connector_headers_too_large");
        return;
      }
      state.requestLine = state.buffer.subarray(0, lineEnd).toString("ascii");
      const parsedHeaders = this.#parseHeaders(
        state.buffer.subarray(lineEnd + 2, headerEnd).toString("latin1"),
      );
      if (parsedHeaders === undefined) {
        this.#respond(socket, state, 400, "connector_framing_invalid");
        return;
      }
      state.headers = parsedHeaders;
      state.buffer = state.buffer.subarray(headerEnd + 4);
      state.parsed = true;
      this.#parsedRequests += 1;
      this.clock.clearTimer(state.headerTimer);
      if (this.#parsedRequests > CONNECTOR_LIMITS.parsedWebhookRequests) {
        this.#respond(socket, state, 503, "connector_request_capacity");
        return;
      }
      const prebody = this.#preBody(state.requestLine, parsedHeaders);
      if (prebody !== undefined) {
        this.#respond(socket, state, prebody[0], prebody[1]);
        return;
      }
      state.declaredLength = Number(parsedHeaders.get("content-length"));
    }
    if (state.declaredLength === undefined) return;
    if (state.buffer.byteLength < state.declaredLength) return;
    if (state.buffer.byteLength > state.declaredLength) {
      this.#respond(socket, state, 400, "connector_framing_invalid");
      return;
    }
    this.#processBody(socket, state, state.buffer);
  }

  #parseHeaders(block: string): Map<string, string> | undefined {
    if (/(?:^|\r\n)[ \t]/u.test(block)) return undefined;
    for (let index = 0; index < block.length; index += 1) {
      const code = block.charCodeAt(index);
      if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
        return undefined;
    }
    const headers = new Map<string, string>();
    for (const line of block === "" ? [] : block.split("\r\n")) {
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([\t\x20-\x7e]*)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) return undefined;
      const name = match[1].toLowerCase();
      if (FORBIDDEN_HEADERS.has(name)) return undefined;
      if (headers.has(name) && DUPLICATE_FORBIDDEN.has(name)) return undefined;
      if (!headers.has(name)) headers.set(name, match[2].replace(/^[ \t]+|[ \t]+$/gu, ""));
    }
    return headers;
  }

  #preBody(line: string, headers: Map<string, string>): readonly [number, string] | undefined {
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[2] !== "HTTP/1.1") return [400, "connector_framing_invalid"];
    if (parts[1] !== "/webhook") return [404, "connector_path_not_found"];
    if (parts[0] !== "POST") return [405, "connector_method_not_allowed"];
    if (headers.get("host") !== `127.0.0.1:${this.port}`) return [421, "connector_host_rejected"];
    const origin = headers.get("origin");
    if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}`)
      return [403, "connector_origin_rejected"];
    const length = headers.get("content-length");
    if (
      length === undefined ||
      !/^(?:0|[1-9][0-9]*)$/u.test(length) ||
      !Number.isSafeInteger(Number(length))
    )
      return [400, "connector_framing_invalid"];
    if (Number(length) > CONNECTOR_LIMITS.webhookBodyBytes)
      return [413, "connector_body_too_large"];
    if (headers.get("content-type") !== "application/json") return [400, "connector_wake_invalid"];
    if (!safeEqual(headers.get("authorization") ?? "", `Bearer ${this.token}`))
      return [401, "connector_auth_failed"];
    const timestamp = headers.get("x-webhook-timestamp") ?? "";
    if (!/^(?:0|[1-9][0-9]{0,11})$/u.test(timestamp) || Number(timestamp) > 253_402_300_799)
      return [400, "connector_timestamp_invalid"];
    const now = Math.floor(this.clock.nowMs() / 1_000);
    if (Number(timestamp) < now - 300 || Number(timestamp) > now + 5)
      return [400, "connector_timestamp_invalid"];
    const signature = headers.get("x-webhook-signature-v2") ?? "";
    if (!/^[0-9a-f]{64}$/u.test(signature)) return [401, "connector_auth_failed"];
    const replay = `${timestamp}.${signature}`;
    this.#expireReplays(now);
    if (this.#replays.has(replay)) return [409, "connector_replay"];
    return undefined;
  }

  #processBody(socket: Socket, state: ConnectionState, body: Buffer): void {
    const headers = state.headers as Map<string, string>;
    const timestamp = headers.get("x-webhook-timestamp") as string;
    const signature = headers.get("x-webhook-signature-v2") as string;
    const actual = createHmac("sha256", this.token)
      .update(timestamp, "ascii")
      .update(".", "ascii")
      .update(body)
      .digest("hex");
    if (!safeEqual(actual, signature)) {
      this.#respond(socket, state, 401, "connector_auth_failed");
      return;
    }
    const requestId = headers.get("x-request-id");
    const idempotency = headers.get("idempotency-key");
    if (
      !URI_UNRESERVED_ID_PATTERN.test(requestId ?? "") ||
      !URI_UNRESERVED_ID_PATTERN.test(idempotency ?? "") ||
      requestId !== idempotency
    ) {
      this.#respond(socket, state, 400, "connector_wake_invalid");
      return;
    }
    const replay = `${timestamp}.${signature}`;
    this.#expireReplays(Math.floor(this.clock.nowMs() / 1_000));
    if (this.#replays.has(replay)) {
      this.#respond(socket, state, 409, "connector_replay");
      return;
    }
    if (this.#replays.size >= 4_096) {
      this.#respond(socket, state, 503, "connector_replay_capacity");
      return;
    }
    this.#replays.set(replay, Number(timestamp));
    const parsed = parseStrictWakeJson(body);
    if (parsed === undefined) {
      this.#respond(socket, state, 400, "connector_wake_invalid");
      return;
    }
    const messageId = rawWakeId(parsed);
    if (messageId === undefined || requestId !== messageId || idempotency !== messageId) {
      this.#respond(socket, state, 400, "connector_wake_invalid");
      return;
    }
    const admission = this.admit(messageId);
    if (admission === "full") {
      this.#respond(socket, state, 503, "connector_queue_full");
      return;
    }
    this.#respond(socket, state, 202, undefined);
  }

  #expireReplays(now: number): void {
    for (const [key, timestamp] of this.#replays)
      if (now - timestamp > 300) this.#replays.delete(key);
  }

  #respond(
    socket: Socket,
    state: ConnectionState,
    status: number,
    error: string | undefined,
  ): void {
    if (state.responded) return;
    state.responded = true;
    const body = Buffer.from(
      error === undefined ? '{"status":"accepted"}' : `{"error":"${error}"}`,
    );
    const head = Buffer.from(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.byteLength}\r\n\r\n`,
      "ascii",
    );
    state.responseStarted = true;
    if (this.stallResponseAfterCommit) {
      socket.write(head);
      return;
    }
    socket.end(Buffer.concat([head, body]));
  }
}
