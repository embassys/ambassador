import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client,
  type FetchLike,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { assertSafeUpstreamResult, type CentralToolDefinition } from "./mcp-contract.js";

const CONNECT_DEADLINE_MS = 5_000;
const CALL_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;
const PROTOCOL_VERSION = "2025-06-18";
const UNPARSED_WRAPPED_VALUE = Symbol("unparsed wrapped value");
type WrappedLiteralDialect = "json" | "python";

export type CentralMcpErrorCode =
  | "central_mcp_authentication_failed"
  | "central_mcp_cancelled"
  | "central_mcp_closed"
  | "central_mcp_connect_failed"
  | "central_mcp_redirect_rejected"
  | "central_mcp_request_failed"
  | "central_mcp_response_invalid"
  | "central_mcp_response_too_large"
  | "invalid_configuration";

const ERROR_MESSAGES: Record<CentralMcpErrorCode, string> = {
  central_mcp_authentication_failed: "Central MCP authentication failed",
  central_mcp_cancelled: "Central MCP request was cancelled",
  central_mcp_closed: "Central MCP client is closed",
  central_mcp_connect_failed: "Central MCP connection failed",
  central_mcp_redirect_rejected: "Central MCP redirect was rejected",
  central_mcp_request_failed: "Central MCP request failed; its outcome may be uncertain",
  central_mcp_response_invalid: "Central MCP response is invalid",
  central_mcp_response_too_large: "Central MCP response exceeded its size limit",
  invalid_configuration: "Central MCP configuration is invalid",
};

export class CentralMcpError extends Error {
  constructor(readonly code: CentralMcpErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CentralMcpError";
  }
}

export interface CentralMcpClientOptions {
  centralMcpUrl: string | URL;
}

interface ConnectingClient {
  controller: AbortController;
  promise: Promise<Client>;
  settled: boolean;
  waiters: number;
}

class CallerCancelled extends Error {}
class InvalidCentralResponse extends Error {}
class RedirectRejected extends Error {}
class RemoteRequestFailed extends Error {}
class ResponseTooLarge extends Error {}

function safeUrl(value: string | URL): URL {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid URL");
    }
    return url;
  } catch {
    throw new CentralMcpError("invalid_configuration");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPlainJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) throw new InvalidCentralResponse();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainJson(item, depth + 1));
  }
  if (!isRecord(value)) throw new InvalidCentralResponse();

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidCentralResponse();
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, toPlainJson(nested, depth + 1)]),
  );
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  const plain = toPlainJson(value);
  if (!isRecord(plain)) throw new InvalidCentralResponse();
  return plain;
}

class WrappedLiteralParser {
  #index = 0;

  constructor(
    private readonly source: string,
    private readonly dialect: WrappedLiteralDialect,
  ) {}

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.source.length) throw new InvalidCentralResponse();
    return value;
  }

  #parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new InvalidCentralResponse();
    this.#skipWhitespace();
    const next = this.source[this.#index];
    if (this.#isStringQuote(next)) return this.#parseString();
    if (next === "{") return this.#parseObject(depth);
    if (next === "[") return this.#parseArray(depth);
    if (next === "-" || (next !== undefined && next >= "0" && next <= "9")) {
      return this.#parseNumber();
    }
    if (this.dialect === "python" && this.source.startsWith("True", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.dialect === "python" && this.source.startsWith("False", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.dialect === "python" && this.source.startsWith("None", this.#index)) {
      this.#index += 4;
      return null;
    }
    if (this.dialect === "json" && this.source.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.dialect === "json" && this.source.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.dialect === "json" && this.source.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    throw new InvalidCentralResponse();
  }

  #parseObject(depth: number): Record<string, unknown> {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return {};
    }

    const entries = new Map<string, unknown>();
    while (true) {
      const next = this.source[this.#index];
      if (!this.#isStringQuote(next)) throw new InvalidCentralResponse();
      const key = this.#parseString();
      if (entries.has(key)) throw new InvalidCentralResponse();
      this.#skipWhitespace();
      if (this.source[this.#index] !== ":") throw new InvalidCentralResponse();
      this.#index += 1;
      entries.set(key, this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const separator = this.source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return Object.fromEntries(entries);
      }
      if (separator !== ",") throw new InvalidCentralResponse();
      this.#index += 1;
      this.#skipWhitespace();
      if (this.source[this.#index] === "}") throw new InvalidCentralResponse();
    }
  }

  #parseArray(depth: number): unknown[] {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return [];
    }

    const values: unknown[] = [];
    while (true) {
      values.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const separator = this.source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return values;
      }
      if (separator !== ",") throw new InvalidCentralResponse();
      this.#index += 1;
      this.#skipWhitespace();
      if (this.source[this.#index] === "]") throw new InvalidCentralResponse();
    }
  }

  #parseString(): string {
    const quote = this.source[this.#index];
    if (quote !== "'" && quote !== '"') throw new InvalidCentralResponse();
    this.#index += 1;
    let value = "";

    while (this.#index < this.source.length) {
      const character = this.source[this.#index];
      this.#index += 1;
      if (character === quote) return value;
      if (character === "\n" || character === "\r" || character === undefined) {
        throw new InvalidCentralResponse();
      }
      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20) throw new InvalidCentralResponse();
        value += character;
        continue;
      }

      const escaped = this.source[this.#index];
      this.#index += 1;
      switch (escaped) {
        case "\\":
          value += escaped;
          break;
        case "'":
          if (this.dialect !== "python") throw new InvalidCentralResponse();
          value += escaped;
          break;
        case '"':
          value += escaped;
          break;
        case "/":
          if (this.dialect !== "json") throw new InvalidCentralResponse();
          value += escaped;
          break;
        case "a":
          if (this.dialect !== "python") throw new InvalidCentralResponse();
          value += "\u0007";
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "v":
          if (this.dialect !== "python") throw new InvalidCentralResponse();
          value += "\v";
          break;
        case "x":
          if (this.dialect !== "python") throw new InvalidCentralResponse();
          value += String.fromCharCode(this.#parseHex(2));
          break;
        case "u":
          value += String.fromCharCode(this.#parseHex(4));
          break;
        case "U": {
          if (this.dialect !== "python") throw new InvalidCentralResponse();
          const codePoint = this.#parseHex(8);
          if (codePoint > 0x10ffff) throw new InvalidCentralResponse();
          value += String.fromCodePoint(codePoint);
          break;
        }
        default:
          throw new InvalidCentralResponse();
      }
    }
    throw new InvalidCentralResponse();
  }

  #parseHex(length: number): number {
    const value = this.source.slice(this.#index, this.#index + length);
    if (value.length !== length || !/^[0-9A-Fa-f]+$/u.test(value)) {
      throw new InvalidCentralResponse();
    }
    this.#index += length;
    return Number.parseInt(value, 16);
  }

  #parseNumber(): number {
    const start = this.#index;
    if (this.source[this.#index] === "-") this.#index += 1;
    if (this.source[this.#index] === "0") {
      this.#index += 1;
    } else {
      if (!this.#isDigit(this.source[this.#index], "1")) throw new InvalidCentralResponse();
      while (this.#isDigit(this.source[this.#index])) this.#index += 1;
    }
    if (this.source[this.#index] === ".") {
      this.#index += 1;
      if (!this.#isDigit(this.source[this.#index])) throw new InvalidCentralResponse();
      while (this.#isDigit(this.source[this.#index])) this.#index += 1;
    }
    const exponent = this.source[this.#index];
    if (exponent === "e" || exponent === "E") {
      this.#index += 1;
      const sign = this.source[this.#index];
      if (sign === "+" || sign === "-") this.#index += 1;
      if (!this.#isDigit(this.source[this.#index])) throw new InvalidCentralResponse();
      while (this.#isDigit(this.source[this.#index])) this.#index += 1;
    }
    const value = Number(this.source.slice(start, this.#index));
    if (!Number.isFinite(value)) throw new InvalidCentralResponse();
    return value;
  }

  #isDigit(value: string | undefined, minimum = "0"): boolean {
    return value !== undefined && value >= minimum && value <= "9";
  }

  #isStringQuote(value: string | undefined): value is "'" | '"' {
    return value === '"' || (this.dialect === "python" && value === "'");
  }

  #skipWhitespace(): void {
    while (/^[\t\n\r ]$/u.test(this.source[this.#index] ?? "")) this.#index += 1;
  }
}

function parseWrappedValue(value: string): unknown | typeof UNPARSED_WRAPPED_VALUE {
  for (const dialect of ["json", "python"] as const) {
    try {
      return toPlainJson(new WrappedLiteralParser(value, dialect).parse());
    } catch {
      // Try the other approved data grammar.
    }
  }
  return UNPARSED_WRAPPED_VALUE;
}

function looksLikeUnsupportedLiteral(value: string): boolean {
  const trimmed = value.trimStart();
  return (
    /^[#'"(]/u.test(trimmed) ||
    /^(?:[bBrRuUfF]{1,2})['"]/u.test(trimmed) ||
    ["[", "]", "{", "}", "(", ")"].some((delimiter) => trimmed.includes(delimiter))
  );
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const metadata = toPlainRecord(value);
    assertSafeUpstreamResult(metadata);
    return metadata;
  } catch {
    throw new InvalidCentralResponse();
  }
}

function assertMetadataCredentialFree(
  metadata: readonly (Record<string, unknown> | undefined)[],
  result: Record<string, unknown>,
  storedCredential?: string,
): void {
  const issuedCredential = typeof result.token === "string" ? result.token : undefined;
  try {
    for (const value of metadata) {
      if (value === undefined) continue;
      if (storedCredential !== undefined) assertSafeUpstreamResult(value, storedCredential);
      if (issuedCredential !== undefined) assertSafeUpstreamResult(value, issuedCredential);
    }
  } catch {
    throw new InvalidCentralResponse();
  }
}

function parseTool(value: unknown): CentralToolDefinition {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new InvalidCentralResponse();
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new InvalidCentralResponse();
  }
  const inputSchema = toPlainRecord(value.inputSchema);
  if (inputSchema.type !== "object" || !isRecord(inputSchema.properties)) {
    throw new InvalidCentralResponse();
  }
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema,
  };
}

function canonicalToolResult(result: unknown, storedCredential?: string): Record<string, unknown> {
  if (!isRecord(result)) throw new InvalidCentralResponse();
  const keys = Object.keys(result);
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new InvalidCentralResponse();
  }
  if (result.isError === true) throw new RemoteRequestFailed();
  const resultMetadata = parseMetadata(result._meta);
  if (
    !keys.includes("content") ||
    !keys.includes("structuredContent") ||
    keys.some(
      (key) =>
        key !== "content" && key !== "structuredContent" && key !== "isError" && key !== "_meta",
    )
  ) {
    throw new InvalidCentralResponse();
  }
  const structuredContent = toPlainRecord(result.structuredContent);
  if (!Array.isArray(result.content)) throw new InvalidCentralResponse();
  if (result.content.length === 0) {
    assertMetadataCredentialFree([resultMetadata], structuredContent, storedCredential);
    return structuredContent;
  }
  if (result.content.length !== 1) throw new InvalidCentralResponse();

  const mirror = result.content[0];
  if (!isRecord(mirror) || mirror.type !== "text" || typeof mirror.text !== "string") {
    throw new InvalidCentralResponse();
  }
  const contentMetadata = parseMetadata(mirror._meta);
  let canonical = structuredContent;
  let serialized: string;
  try {
    serialized = JSON.stringify(structuredContent);
  } catch {
    throw new InvalidCentralResponse();
  }
  if (mirror.text !== serialized) {
    const structuredKeys = Object.keys(structuredContent);
    if (
      structuredKeys.length !== 1 ||
      structuredKeys[0] !== "result" ||
      typeof structuredContent.result !== "string" ||
      mirror.text !== structuredContent.result
    ) {
      throw new InvalidCentralResponse();
    }
    const normalized = parseWrappedValue(structuredContent.result);
    if (normalized !== UNPARSED_WRAPPED_VALUE) {
      canonical = isRecord(normalized) ? normalized : { result: normalized };
    } else if (looksLikeUnsupportedLiteral(structuredContent.result)) {
      throw new InvalidCentralResponse();
    }
  }
  assertMetadataCredentialFree([resultMetadata, contentMetadata], canonical, storedCredential);
  return canonical;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The rejection reason is intentionally discarded.
  }
}

function boundedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          controller.close();
          return;
        }
        received += item.value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The size violation remains authoritative.
          }
          controller.error(new ResponseTooLarge());
          return;
        }
        controller.enqueue(item.value);
      } catch {
        controller.error(new RemoteRequestFailed());
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation must not expose a transport error.
      }
    },
  });
}

async function boundedFetch(
  url: string | URL,
  init: RequestInit | undefined,
  lifetimeSignal: AbortSignal,
  connectSignal: AbortSignal | undefined,
  operationSignal: AbortSignal | undefined,
): Promise<Response> {
  const signals = [lifetimeSignal];
  if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
  if (connectSignal !== undefined) signals.push(connectSignal);
  if (operationSignal !== undefined) signals.push(operationSignal);

  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: signals.length === 1 ? lifetimeSignal : AbortSignal.any(signals),
  });
  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response);
    throw new RedirectRejected();
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new ResponseTooLarge();
    }
  }
  if (response.body === null) return response;
  return new Response(boundedBody(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CallerCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new CallerCancelled());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class CentralMcpClient {
  private readonly centralMcpUrl: URL;
  private readonly lifetimeController = new AbortController();
  private readonly operationSignals = new AsyncLocalStorage<AbortSignal>();
  private client: Client | undefined;
  private connecting: ConnectingClient | undefined;
  private closed = false;

  constructor(options: CentralMcpClientOptions) {
    try {
      this.centralMcpUrl = safeUrl(options.centralMcpUrl);
    } catch {
      throw new CentralMcpError("invalid_configuration");
    }
  }

  async listTools(callerSignal?: AbortSignal): Promise<CentralToolDefinition[]> {
    if (callerSignal?.aborted) throw new CentralMcpError("central_mcp_cancelled");
    const client = await this.getClient(callerSignal);
    const signals = [this.lifetimeController.signal, AbortSignal.timeout(CALL_DEADLINE_MS)];
    if (callerSignal !== undefined) signals.push(callerSignal);
    const signal = AbortSignal.any(signals);
    try {
      const result = await this.operationSignals.run(signal, async () =>
        client.listTools(undefined, {
          cacheMode: "bypass",
          signal,
          timeout: CALL_DEADLINE_MS,
        }),
      );
      return result.tools.map(parseTool);
    } catch (error) {
      throw this.safeError(error, "request", callerSignal);
    }
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    callerSignal?: AbortSignal,
    storedCredential?: string,
  ): Promise<Record<string, unknown>> {
    if (callerSignal?.aborted) throw new CentralMcpError("central_mcp_cancelled");
    const client = await this.getClient(callerSignal);
    const signals = [this.lifetimeController.signal, AbortSignal.timeout(CALL_DEADLINE_MS)];
    if (callerSignal !== undefined) signals.push(callerSignal);
    const signal = AbortSignal.any(signals);
    try {
      if (typeof name !== "string" || name.length === 0 || !isRecord(arguments_)) {
        throw new RemoteRequestFailed();
      }
      const result = await this.operationSignals.run(signal, async () =>
        client.callTool(
          { name, arguments: arguments_ },
          {
            signal,
            timeout: CALL_DEADLINE_MS,
            // Supplying a definition disables the SDK's header-mismatch refetch-and-retry path.
            toolDefinition: { name, inputSchema: { type: "object", properties: {} } },
          },
        ),
      );
      return canonicalToolResult(result, storedCredential);
    } catch (error) {
      throw this.safeError(error, "request", callerSignal);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetimeController.abort();
    this.connecting?.controller.abort();
    const connecting = this.connecting?.promise.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    await Promise.allSettled([connecting, client?.close()]);
  }

  private async getClient(callerSignal?: AbortSignal): Promise<Client> {
    if (this.closed) throw new CentralMcpError("central_mcp_closed");
    if (callerSignal?.aborted) throw new CentralMcpError("central_mcp_cancelled");
    if (this.client !== undefined) return this.client;

    let connecting = this.connecting;
    if (connecting === undefined) {
      const controller = new AbortController();
      const state: ConnectingClient = {
        controller,
        promise: this.openConnection(controller.signal),
        settled: false,
        waiters: 0,
      };
      state.promise = state.promise.finally(() => {
        state.settled = true;
        if (this.connecting === state) this.connecting = undefined;
      });
      this.connecting = state;
      connecting = state;
    }

    connecting.waiters += 1;
    const waitSignal =
      callerSignal === undefined
        ? this.lifetimeController.signal
        : AbortSignal.any([callerSignal, this.lifetimeController.signal]);
    try {
      return await awaitWithSignal(connecting.promise, waitSignal);
    } catch (error) {
      throw this.safeError(error, "connect", callerSignal);
    } finally {
      connecting.waiters -= 1;
      if (!connecting.settled && connecting.waiters === 0 && waitSignal.aborted) {
        connecting.controller.abort();
      }
    }
  }

  private async openConnection(connectControllerSignal: AbortSignal): Promise<Client> {
    const deadlineSignal = AbortSignal.timeout(CONNECT_DEADLINE_MS);
    const connectSignal = AbortSignal.any([
      this.lifetimeController.signal,
      connectControllerSignal,
      deadlineSignal,
    ]);
    let connecting = true;
    const request: FetchLike = async (url, init) =>
      await boundedFetch(
        url,
        init,
        this.lifetimeController.signal,
        connecting && init?.method !== "GET" ? connectSignal : undefined,
        this.operationSignals.getStore(),
      );
    const transport = new StreamableHTTPClientTransport(this.centralMcpUrl, {
      fetch: request,
      onInsufficientScope: "throw",
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 0,
      },
      requestInit: { redirect: "manual" },
    });
    const client = new Client(
      { name: "a2a-gateway", version: "1" },
      {
        inputRequired: { autoFulfill: false },
        supportedProtocolVersions: [PROTOCOL_VERSION],
        versionNegotiation: { mode: "legacy" },
      },
    );
    client.onerror = () => {
      // SDK and upstream error details are intentionally discarded.
    };
    client.onclose = () => {
      if (this.client === client) this.client = undefined;
    };

    try {
      await client.connect(transport, {
        signal: connectSignal,
        timeout: CONNECT_DEADLINE_MS,
      });
      if (this.closed) throw new CentralMcpError("central_mcp_closed");
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw this.safeError(error, "connect");
    } finally {
      connecting = false;
    }
  }

  private safeError(
    error: unknown,
    phase: "connect" | "request",
    callerSignal?: AbortSignal,
  ): CentralMcpError {
    if (error instanceof CentralMcpError) return error;
    if (callerSignal?.aborted) return new CentralMcpError("central_mcp_cancelled");
    if (this.closed || this.lifetimeController.signal.aborted) {
      return new CentralMcpError("central_mcp_closed");
    }
    if (error instanceof RedirectRejected) {
      return new CentralMcpError("central_mcp_redirect_rejected");
    }
    if (error instanceof ResponseTooLarge) {
      return new CentralMcpError("central_mcp_response_too_large");
    }
    if (error instanceof InvalidCentralResponse) {
      return new CentralMcpError("central_mcp_response_invalid");
    }
    if (
      (error instanceof SdkHttpError && error.status === 401) ||
      (error instanceof ProtocolError && error.code === -32_001)
    ) {
      return new CentralMcpError("central_mcp_authentication_failed");
    }
    return new CentralMcpError(
      phase === "connect" ? "central_mcp_connect_failed" : "central_mcp_request_failed",
    );
  }
}
