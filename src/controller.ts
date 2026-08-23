import type { FetchLike } from "./adapters/types.js";
import { requestTimeout, withDeadline } from "./http.js";
import {
  type PersistenceAcknowledgement,
  type PollResponse,
  parsePollResponse,
  type WakeReport,
} from "./protocol.js";

const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const PROTOCOL_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function parseControllerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Controller base URL is invalid");
  }

  const validProtocol =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!validProtocol || url.username !== "" || url.password !== "") {
    throw new Error("Controller base URL must use HTTPS or loopback HTTP");
  }
  return url;
}

function discardBody(response: Response): void {
  if (response.body !== null) {
    void response.body.cancel().catch(() => undefined);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const milliseconds = Math.ceil(date - Date.now());
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function responseError(response: Response): ControllerRequestError {
  const retryAfter = retryAfterMs(response);
  if (response.status === 401 || response.status === 403) {
    return new ControllerRequestError("authentication_failed", false);
  }
  if (response.status === 429) {
    return new ControllerRequestError("rate_limited", true, retryAfter);
  }
  if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
    return new ControllerRequestError("unavailable", true, retryAfter);
  }
  return new ControllerRequestError("request_rejected", false);
}

function safeRequestError(operation: string, signal: AbortSignal): Error {
  if (signal.aborted) {
    const error = new Error(`${operation} was aborted`);
    error.name =
      signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "TimeoutError"
        : "AbortError";
    return error;
  }
  return new Error(`${operation} failed`);
}

async function request(
  fetch: FetchLike,
  url: URL,
  init: RequestInit,
  operation: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw safeRequestError(operation, signal);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new Error("Response body is missing");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Response body exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Response body is not valid JSON");
  }
}

export interface ControllerClient {
  poll(
    cursor: string | null,
    signal: AbortSignal,
    options?: PollRequestOptions,
  ): Promise<ControllerPollResult>;
  acknowledge(message: PersistenceAcknowledgement, signal: AbortSignal): Promise<void>;
  report(message: WakeReport, signal: AbortSignal): Promise<void>;
}

export interface ControllerPollResult {
  response: PollResponse;
  receivedAtMs: number;
}

export interface PollRequestOptions {
  waitSeconds?: number;
  maxNotifications?: number;
}

export class ControllerRequestError extends Error {
  readonly code: "authentication_failed" | "rate_limited" | "request_rejected" | "unavailable";
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: ControllerRequestError["code"], retryable: boolean, retryAfterMs?: number) {
    super("Controller request failed");
    this.name = "ControllerRequestError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface HttpControllerOptions {
  baseUrl: string;
  token: string;
  waitSeconds: number;
  maxNotifications: number;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  now?: () => number;
}

export class HttpControllerClient implements ControllerClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly waitSeconds: number;
  private readonly maxNotifications: number;
  private readonly fetch: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: HttpControllerOptions) {
    this.baseUrl = parseControllerUrl(options.baseUrl);
    if (options.token.length === 0 || /[\r\n]/u.test(options.token)) {
      throw new Error("Controller token is invalid");
    }
    if (
      !Number.isInteger(options.waitSeconds) ||
      options.waitSeconds < 1 ||
      options.waitSeconds > 300
    ) {
      throw new Error("Controller poll wait must be an integer from 1 to 300 seconds");
    }
    if (
      !Number.isInteger(options.maxNotifications) ||
      options.maxNotifications < 1 ||
      options.maxNotifications > 1000
    ) {
      throw new Error("Controller batch size must be an integer from 1 to 1000");
    }

    this.token = options.token;
    this.waitSeconds = options.waitSeconds;
    this.maxNotifications = options.maxNotifications;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.requestTimeoutMs = requestTimeout(
      options.requestTimeoutMs,
      10_000,
      "Controller request timeout",
    );
    this.now = options.now ?? Date.now;
  }

  async poll(
    cursor: string | null,
    signal: AbortSignal,
    options: PollRequestOptions = {},
  ): Promise<ControllerPollResult> {
    const waitSeconds = options.waitSeconds ?? this.waitSeconds;
    const maxNotifications = options.maxNotifications ?? this.maxNotifications;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > this.waitSeconds) {
      throw new Error("Controller poll override wait is invalid");
    }
    if (
      !Number.isInteger(maxNotifications) ||
      maxNotifications < 1 ||
      maxNotifications > this.maxNotifications
    ) {
      throw new Error("Controller poll override batch size is invalid");
    }
    const requestAbort = withDeadline(signal, waitSeconds * 1_000 + this.requestTimeoutMs);
    const url = new URL("/v1/sidecar/notifications", this.baseUrl);
    if (cursor !== null) {
      if (!PROTOCOL_ID.test(cursor)) {
        throw new Error("Controller poll cursor is invalid");
      }
      url.searchParams.set("cursor", cursor);
    }
    url.searchParams.set("wait_seconds", String(waitSeconds));
    url.searchParams.set("max_notifications", String(maxNotifications));

    const response = await request(
      this.fetch,
      url,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: requestAbort,
      },
      "Controller poll request",
      requestAbort,
    );
    const receivedAtMs = this.now();
    if (!response.ok) {
      discardBody(response);
      throw responseError(response);
    }

    let input: unknown;
    try {
      input = await readBoundedJson(response);
    } catch {
      throw safeRequestError("Controller poll response", signal);
    }
    try {
      return { response: parsePollResponse(input), receivedAtMs };
    } catch {
      throw new ControllerRequestError("request_rejected", false);
    }
  }

  async acknowledge(message: PersistenceAcknowledgement, signal: AbortSignal): Promise<void> {
    const requestAbort = withDeadline(signal, this.requestTimeoutMs);
    const body = JSON.stringify({
      protocol_version: message.protocol_version,
      notification_id: message.notification_id,
      delivery_id: message.delivery_id,
      status: message.status,
      persisted_at: message.persisted_at,
    });
    const url = new URL(
      `/v1/sidecar/notifications/${encodeURIComponent(message.notification_id)}/ack`,
      this.baseUrl,
    );
    const response = await request(
      this.fetch,
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: requestAbort,
      },
      "Controller acknowledgement request",
      requestAbort,
    );
    discardBody(response);
    if (!response.ok) {
      throw responseError(response);
    }
  }

  async report(message: WakeReport, signal: AbortSignal): Promise<void> {
    const requestAbort = withDeadline(signal, this.requestTimeoutMs);
    const body = JSON.stringify({
      protocol_version: message.protocol_version,
      report_id: message.report_id,
      sequence: message.sequence,
      notification_id: message.notification_id,
      delivery_id: message.delivery_id,
      status: message.status,
      ...(message.reason === undefined ? {} : { reason: message.reason }),
      observed_at: message.observed_at,
      ...(message.next_attempt_at === undefined
        ? {}
        : { next_attempt_at: message.next_attempt_at }),
    });
    const url = new URL("/v1/sidecar/wake-reports", this.baseUrl);
    const response = await request(
      this.fetch,
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: requestAbort,
      },
      "Controller wake report request",
      requestAbort,
    );
    discardBody(response);
    if (!response.ok) {
      throw responseError(response);
    }
  }
}
