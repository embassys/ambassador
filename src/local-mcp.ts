import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { toWebRequest } from "@modelcontextprotocol/node";
import {
  ProtocolError,
  Server,
  type Tool,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { serializeLocalToolResult } from "./local-tool-result.js";
import type { CentralToolDefinition } from "./mcp-contract.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024;
const MAX_SESSIONS = 32;
const MAX_CONCURRENT_TOOL_CALLS = 8;
const LOCAL_REQUEST_TIMEOUT_MS = 35_000;
const PROTOCOL_VERSION = "2025-06-18";

export interface LocalMcpRouter {
  listTools(): Promise<CentralToolDefinition[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
    clientInfo: LocalMcpClientInfo | undefined,
  ): Promise<Record<string, unknown>>;
}

export interface LocalMcpClientInfo {
  readonly name: string;
  readonly version: string;
}

export class LocalMcpToolError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number | null,
  ) {
    super("Tool call failed");
    this.name = "LocalMcpToolError";
  }

  get data(): Record<string, unknown> {
    return {
      code: this.code,
      ...(this.retryAfterMs === undefined ? {} : { retry_after_ms: this.retryAfterMs }),
    };
  }
}

export interface LocalMcpServerOptions {
  port?: number;
  requestTimeoutMs?: number;
}

export class LocalMcpServerError extends Error {
  constructor(
    readonly code: "address_in_use" | "listen_failed",
    readonly port: number,
  ) {
    super("Local MCP server failed");
    this.name = "LocalMcpServerError";
  }
}

interface McpSession {
  id?: string;
  sdk: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  closing: boolean;
}

class RequestBodyTooLarge extends Error {}
class ResponseBodyTooLarge extends Error {}

function safeHttpError(response: ServerResponse, status: number): void {
  if (!response.headersSent) {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
  }
  response.end("Request rejected\n");
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        settled = true;
        request.pause();
        reject(new RequestBodyTooLarge());
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("Invalid request body"));
      }
    });
    request.once("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Request aborted"));
    });
    request.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Request failed"));
    });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInitializeRequest(value: unknown): boolean {
  return isObject(value) && value.method === "initialize";
}

function sessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function responseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyTooLarge();
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
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLarge();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ResponseBodyTooLarge) throw error;
    throw new Error("MCP response failed");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function writeWebResponse(
  request: IncomingMessage,
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  if (request.method !== "GET") {
    const bytes = await readBoundedResponse(webResponse);
    response.writeHead(webResponse.status, responseHeaders(webResponse));
    response.end(bytes);
    return;
  }

  response.writeHead(webResponse.status, responseHeaders(webResponse));
  if (webResponse.body === null) {
    response.end();
    return;
  }

  const reader = webResponse.body.getReader();
  let total = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  response.once("close", cancel);
  try {
    while (!response.destroyed) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (!response.write(item.value)) await once(response, "drain");
    }
  } finally {
    response.off("close", cancel);
    if (!response.destroyed) response.end();
  }
}

export class LocalMcpServer {
  readonly #http: HttpServer;
  readonly #requestTimeoutMs: number;
  readonly #port: number;
  readonly #sessions = new Map<string, McpSession>();
  readonly #sessionRecords = new Set<McpSession>();
  #activeToolCalls = 0;
  #accepting = false;
  #endpoint: string | undefined;

  constructor(
    private readonly router: LocalMcpRouter,
    options: LocalMcpServerOptions = {},
  ) {
    this.#port = options.port ?? 8787;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new Error("Invalid MCP listener port");
    }
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error("Invalid MCP request timeout");
    }

    this.#http = createHttpServer(
      { maxHeaderSize: MAX_HEADERS_BYTES, requestTimeout: this.#requestTimeoutMs },
      (request, response) => {
        void this.#handleRequest(request, response);
      },
    );
  }

  get endpoint(): string {
    if (this.#endpoint === undefined) throw new Error("MCP listener is not bound");
    return this.#endpoint;
  }

  async listen(): Promise<void> {
    if (this.#accepting || this.#endpoint !== undefined) {
      throw new Error("MCP listener is already bound");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void =>
        reject(
          new LocalMcpServerError(
            error.code === "EADDRINUSE" ? "address_in_use" : "listen_failed",
            this.#port,
          ),
        );
      this.#http.once("error", onError);
      this.#http.listen(this.#port, "127.0.0.1", () => {
        this.#http.off("error", onError);
        resolve();
      });
    });
    const address = this.#http.address() as AddressInfo;
    this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.#accepting = true;
  }

  async close(): Promise<void> {
    this.#accepting = false;
    const closed = new Promise<void>((resolve) => {
      if (!this.#http.listening) {
        resolve();
        return;
      }
      this.#http.close(() => resolve());
    });
    await Promise.all([...this.#sessionRecords].map((record) => this.#closeSession(record)));
    this.#http.closeAllConnections();
    await closed;
  }

  #createSdk(): Server {
    const sdk = new Server(
      { name: "ambassador", version: "1" },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: [PROTOCOL_VERSION],
      },
    );
    sdk.onerror = () => undefined;
    sdk.setRequestHandler("tools/list", async () => {
      const tools = await this.router.listTools();
      return { tools: tools as Tool[] };
    });
    sdk.setRequestHandler("tools/call", async (request, context) => {
      if (this.#activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
        throw new Error("Tool call capacity reached");
      }
      const arguments_ = request.params.arguments;
      if (arguments_ !== undefined && !isObject(arguments_)) {
        throw new Error("Invalid tool arguments");
      }

      this.#activeToolCalls += 1;
      try {
        const signal = AbortSignal.any([
          context.mcpReq.signal,
          AbortSignal.timeout(this.#requestTimeoutMs),
        ]);
        const version = sdk.getClientVersion();
        const clientInfo =
          version !== undefined &&
          typeof version.name === "string" &&
          typeof version.version === "string"
            ? { name: version.name, version: version.version }
            : undefined;
        const result = await this.router.callTool(
          request.params.name,
          arguments_ ?? {},
          signal,
          clientInfo,
        );
        const serialized = serializeLocalToolResult(result);
        return sdk.projectCallToolResult(
          {
            content: [{ type: "text", text: serialized }],
            structuredContent: result,
          },
          undefined,
        );
      } catch (error) {
        if (error instanceof LocalMcpToolError) {
          throw new ProtocolError(-32_002, "Tool call failed", error.data);
        }
        throw new Error("Tool call failed");
      } finally {
        this.#activeToolCalls -= 1;
      }
    });
    return sdk;
  }

  async #createSession(): Promise<McpSession> {
    if (this.#sessionRecords.size >= MAX_SESSIONS) {
      throw new Error("MCP session capacity reached");
    }
    const sdk = this.#createSdk();
    let record: McpSession;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      keepAliveMs: 15_000,
      onsessioninitialized: (id) => {
        if (this.#sessions.has(id)) throw new Error("Duplicate MCP session");
        record.id = id;
        this.#sessions.set(id, record);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
        void this.#closeSession(record);
      },
    });
    record = { sdk, transport, closing: false };
    this.#sessionRecords.add(record);
    try {
      await sdk.connect(transport);
      return record;
    } catch (error) {
      this.#sessionRecords.delete(record);
      await sdk.close().catch(() => undefined);
      throw error;
    }
  }

  async #closeSession(record: McpSession): Promise<void> {
    if (record.closing) return;
    record.closing = true;
    if (record.id !== undefined) this.#sessions.delete(record.id);
    this.#sessionRecords.delete(record);
    await record.sdk.close().catch(() => undefined);
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#accepting) {
      safeHttpError(response, 503);
      return;
    }
    if (request.url !== "/mcp") {
      safeHttpError(response, 404);
      return;
    }

    const address = this.#http.address() as AddressInfo;
    if (request.headers.host !== `127.0.0.1:${address.port}`) {
      safeHttpError(response, 421);
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${address.port}`) {
      safeHttpError(response, 403);
      return;
    }
    if (request.headers.authorization !== undefined) {
      safeHttpError(response, 400);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    const onResponseClose = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onResponseClose);
    let record: McpSession | undefined;
    let transientSession = false;
    try {
      const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
      if (Array.isArray(parsedBody)) {
        safeHttpError(response, 400);
        return;
      }
      const id = sessionId(request);
      if (id === undefined) {
        if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
          safeHttpError(response, 400);
          return;
        }
        try {
          record = await this.#createSession();
          transientSession = true;
        } catch {
          safeHttpError(response, 503);
          return;
        }
      } else {
        record = this.#sessions.get(id);
        if (record === undefined) {
          safeHttpError(response, 404);
          return;
        }
      }

      const webRequest = await toWebRequest(
        request as IncomingMessage & { method: string; url: string },
        parsedBody,
        { signal: controller.signal },
      );
      const webResponse = await record.transport.handleRequest(webRequest, { parsedBody });
      await writeWebResponse(request, response, webResponse);
      if (transientSession && record.id === undefined) await this.#closeSession(record);
    } catch (error) {
      if (transientSession && record !== undefined && record.id === undefined) {
        await this.#closeSession(record);
      }
      if (error instanceof RequestBodyTooLarge) {
        request.resume();
        safeHttpError(response, 413);
        return;
      }
      if (!response.headersSent) safeHttpError(response, 400);
    } finally {
      clearTimeout(timeout);
      response.off("close", onResponseClose);
    }
  }
}
