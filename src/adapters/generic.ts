import { createHmac } from "node:crypto";

import { PROTOCOL_VERSION, parseWakeResponse, type WakeResponse } from "../protocol.js";
import type { FetchLike, HealthResult, WakeAdapter, WakeInput } from "./types.js";

const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const PROTOCOL_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function parseRuntimeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Runtime URL is invalid");
  }

  const validProtocol =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!validProtocol || url.username !== "" || url.password !== "") {
    throw new Error("Runtime URL must use HTTPS or loopback HTTP");
  }
  return url;
}

function discardBody(response: Response): void {
  if (response.body !== null) {
    void response.body.cancel().catch(() => undefined);
  }
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

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Response body is not valid JSON");
  }
}

export interface GenericWebhookOptions {
  url: string;
  healthUrl?: string;
  secret: string;
  fetch?: FetchLike;
  now?: () => number;
}

export class GenericWebhookAdapter implements WakeAdapter {
  private readonly url: URL;
  private readonly healthUrl: URL;
  private readonly secret: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(options: GenericWebhookOptions) {
    this.url = parseRuntimeUrl(options.url);
    this.healthUrl = parseRuntimeUrl(options.healthUrl ?? options.url);
    if (options.secret.length === 0) {
      throw new Error("Runtime webhook secret is invalid");
    }
    this.secret = options.secret;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async health(signal: AbortSignal): Promise<HealthResult> {
    let response: Response;
    try {
      response = await this.fetch(this.healthUrl, { method: "GET", redirect: "error", signal });
    } catch {
      return { healthy: false };
    }
    discardBody(response);
    return { healthy: response.ok };
  }

  async wake(input: WakeInput, signal: AbortSignal): Promise<WakeResponse> {
    if (!PROTOCOL_ID.test(input.deliveryId)) {
      throw new Error("Runtime wake delivery ID is invalid");
    }
    const now = this.now();
    const date = new Date(now);
    if (!Number.isFinite(now) || Number.isNaN(date.getTime())) {
      throw new Error("Runtime wake timestamp is invalid");
    }

    const timestamp = String(Math.floor(now / 1000));
    const body = JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      delivery_id: input.deliveryId,
      sent_at: date.toISOString(),
    });
    const signature = createHmac("sha256", this.secret)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");

    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature-v2": signature,
        },
        body,
        redirect: "error",
        signal,
      });
    } catch {
      throw safeRequestError("Runtime wake request", signal);
    }
    if (!response.ok) {
      discardBody(response);
      throw new Error(`Runtime wake failed with HTTP status ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await readBoundedJson(response);
    } catch {
      throw safeRequestError("Runtime wake response", signal);
    }
    try {
      return parseWakeResponse(parsed);
    } catch {
      throw new Error("Runtime wake response failed protocol validation");
    }
  }
}
