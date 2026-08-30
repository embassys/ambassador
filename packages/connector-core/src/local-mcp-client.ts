import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { CONNECTOR_LIMITS, ConnectorError } from "./constants.js";
import type { ConnectorClock } from "./runtime-types.js";

const MAX_GATEWAY_RESPONSE_BYTES = 4_194_304;

export class GatewayObservation extends Error {
  constructor(
    readonly kind: "application" | "uncertain" | "contract" | "timeout",
    readonly code?: string,
    readonly retryAfterMs?: unknown,
  ) {
    super("connector_gateway_observation");
    this.name = "GatewayObservation";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "manual" });
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_GATEWAY_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new GatewayObservation("contract");
  }
  if (response.body === null) return response;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new GatewayObservation("contract");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== length) throw new GatewayObservation("contract");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (
    response.status === 200 &&
    typeof init?.body === "string" &&
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
      "application/json"
  ) {
    let request: unknown;
    let result: unknown;
    try {
      request = JSON.parse(init.body);
      result = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new GatewayObservation("contract");
    }
    if (
      object(request) &&
      (typeof request.id === "number" || typeof request.id === "string") &&
      (!object(result) || result.jsonrpc !== "2.0" || result.id !== request.id)
    ) {
      throw new GatewayObservation("contract");
    }
  }
  return new Response(bytes, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export class GatewayClient {
  readonly #controllers = new Set<AbortController>();
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  #initializing: Promise<void> | undefined;
  #closed = false;

  constructor(
    endpoint: string,
    token: string,
    private readonly clock: ConnectorClock,
  ) {
    this.#client = new Client(
      { name: "a2a-connector", version: "1" },
      { supportedProtocolVersions: ["2025-06-18"], enforceStrictCapabilities: true },
    );
    this.#client.onerror = () => {};
    this.#transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: boundedFetch,
      requestInit: {
        redirect: "manual",
        headers: { authorization: `Bearer ${token}` },
      },
    });
  }

  async call(
    tool: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new GatewayObservation("uncertain");
    await this.#initialize();
    const result = await this.#bounded((signal) =>
      this.#client.callTool(
        { name: tool, arguments: structuredClone(arguments_) },
        {
          signal,
          timeout: CONNECTOR_LIMITS.gatewayMcpDeadlineMs,
          maxTotalTimeout: CONNECTOR_LIMITS.gatewayMcpDeadlineMs,
        },
      ),
    );
    if (result.isError === true || !object(result.structuredContent)) {
      throw new GatewayObservation("contract");
    }
    return structuredClone(result.structuredContent);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    await this.#client.close().catch(() => {});
  }

  async #initialize(): Promise<void> {
    if (this.#initializing === undefined) {
      this.#initializing = this.#bounded((signal) =>
        this.#client.connect(this.#transport, {
          signal,
          timeout: CONNECTOR_LIMITS.gatewayMcpDeadlineMs,
          maxTotalTimeout: CONNECTOR_LIMITS.gatewayMcpDeadlineMs,
        }),
      );
    }
    await this.#initializing;
  }

  async #bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = this.clock.setTimer(
      () => controller.abort(),
      CONNECTOR_LIMITS.gatewayMcpDeadlineMs,
    );
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (error instanceof GatewayObservation) throw error;
      if (error instanceof ConnectorError) throw error;
      if (controller.signal.aborted) throw new GatewayObservation("timeout");
      if (error instanceof ProtocolError) {
        if (object(error.data) && typeof error.data.code === "string") {
          throw new GatewayObservation("application", error.data.code, error.data.retry_after_ms);
        }
        throw new GatewayObservation("contract");
      }
      if (error instanceof SdkHttpError) {
        if (error.status === 401) {
          throw new GatewayObservation("application", "authentication_failed");
        }
        throw new GatewayObservation("contract");
      }
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        throw new GatewayObservation("timeout");
      }
      throw new GatewayObservation("uncertain");
    } finally {
      this.clock.clearTimer(timer);
      this.#controllers.delete(controller);
    }
  }
}
