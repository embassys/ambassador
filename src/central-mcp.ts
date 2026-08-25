import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client,
  type FetchLike,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { CentralToolDefinition } from "./mcp-contract.js";

const CONNECT_DEADLINE_MS = 5_000;
const CALL_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;
const PROTOCOL_VERSION = "2025-06-18";

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

function canonicalToolResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new InvalidCentralResponse();
  const keys = Object.keys(result);
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new InvalidCentralResponse();
  }
  if (result.isError === true) throw new RemoteRequestFailed();
  if (
    !keys.includes("content") ||
    !keys.includes("structuredContent") ||
    keys.some((key) => key !== "content" && key !== "structuredContent" && key !== "isError")
  ) {
    throw new InvalidCentralResponse();
  }
  const structuredContent = toPlainRecord(result.structuredContent);
  if (!Array.isArray(result.content)) throw new InvalidCentralResponse();
  if (result.content.length === 0) return structuredContent;
  if (result.content.length !== 1) throw new InvalidCentralResponse();

  const mirror = result.content[0];
  if (!isRecord(mirror) || mirror.type !== "text" || typeof mirror.text !== "string") {
    throw new InvalidCentralResponse();
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(structuredContent);
  } catch {
    throw new InvalidCentralResponse();
  }
  if (mirror.text !== serialized) throw new InvalidCentralResponse();
  return structuredContent;
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
      return canonicalToolResult(result);
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
