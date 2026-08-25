import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type Tool } from "@modelcontextprotocol/server";

import type { CentralToolDefinition } from "./mcp-contract.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 8;
const LOCAL_REQUEST_TIMEOUT_MS = 35_000;

export interface LocalMcpRouter {
  listTools(): Promise<CentralToolDefinition[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface LocalMcpServerOptions {
  port?: number;
  requestTimeoutMs?: number;
}

class RequestBodyTooLarge extends Error {}

function safeHttpError(response: ServerResponse, status: number): void {
  if (!response.headersSent) {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
  }
  response.end("Request rejected\n");
}

function authenticate(value: string | undefined, expectedDigest: Buffer): boolean {
  const actualDigest = createHash("sha256")
    .update(value ?? "", "utf8")
    .digest();
  return timingSafeEqual(actualDigest, expectedDigest);
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

export class LocalMcpServer {
  readonly #sdk: Server;
  readonly #transport: NodeStreamableHTTPServerTransport;
  readonly #http: HttpServer;
  readonly #expectedAuthorizationDigest: Buffer;
  readonly #requestTimeoutMs: number;
  readonly #port: number;
  #activeToolCalls = 0;
  #accepting = false;
  #endpoint: string | undefined;

  constructor(
    webhookToken: string,
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

    this.#expectedAuthorizationDigest = createHash("sha256")
      .update(`Bearer ${webhookToken}`, "utf8")
      .digest();
    this.#sdk = new Server(
      { name: "a2a-gateway", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.#sdk.onerror = () => undefined;
    this.#sdk.setRequestHandler("tools/list", async () => {
      const tools = await this.router.listTools();
      return { tools: tools as Tool[] };
    });
    this.#sdk.setRequestHandler("tools/call", async (request, context) => {
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
        const result = await this.router.callTool(request.params.name, arguments_ ?? {}, signal);
        return this.#sdk.projectCallToolResult(
          {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          },
          undefined,
        );
      } catch {
        throw new Error("Tool call failed");
      } finally {
        this.#activeToolCalls -= 1;
      }
    });

    this.#transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      keepAliveMs: 15_000,
    });
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
    await this.#sdk.connect(this.#transport);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (): void => reject(new Error("MCP listener failed to bind"));
        this.#http.once("error", onError);
        this.#http.listen(this.#port, "127.0.0.1", () => {
          this.#http.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      await this.#sdk.close().catch(() => undefined);
      throw error;
    }
    const address = this.#http.address() as AddressInfo;
    this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.#accepting = true;
  }

  async sendToolListChanged(): Promise<void> {
    await this.#sdk.sendToolListChanged();
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
    await this.#sdk.close().catch(() => undefined);
    this.#http.closeAllConnections();
    await closed;
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
    if (!authenticate(request.headers.authorization, this.#expectedAuthorizationDigest)) {
      safeHttpError(response, 401);
      return;
    }

    try {
      const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
      await this.#transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        request.resume();
        safeHttpError(response, 413);
        return;
      }
      safeHttpError(response, 400);
    }
  }
}
