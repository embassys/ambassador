import { createHmac } from "node:crypto";
import { z } from "zod";

import type { WakeResponse } from "../protocol.js";
import type { FetchLike, HealthResult, WakeAdapter, WakeInput } from "./types.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);
const acceptedSchema = z.strictObject({
  status: z.literal("accepted"),
  route: z.string().min(1).max(128),
  event: z.string().min(1).max(128),
  delivery_id: idSchema,
});
const duplicateSchema = z.strictObject({
  status: z.literal("duplicate"),
  delivery_id: idSchema,
});

export interface HermesWebhookOptions {
  url: string;
  healthUrl?: string;
  secret: string;
  fetch?: FetchLike;
  now?: () => number;
  wakeTimeoutMs?: number;
  healthTimeoutMs?: number;
}

function safeRuntimeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Runtime URL is invalid");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Runtime URL must use HTTPS unless it is loopback");
  }
  return url;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    throw new Error("Runtime response is too large");
  }
  if (response.body === null) throw new Error("Runtime response body is missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Runtime response is too large");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Runtime returned invalid JSON");
  }
}

function statusResult(response: Response): WakeResponse {
  if (response.status === 401 || response.status === 403) {
    return { protocol_version: 1, status: "permanent_error", code: "unauthorized" };
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    return {
      protocol_version: 1,
      status: "retryable_error",
      code: "rate_limited",
      ...(delay === undefined ? {} : { retry_after_ms: delay }),
    };
  }
  if ([400, 404, 405, 413, 422].includes(response.status)) {
    return { protocol_version: 1, status: "permanent_error", code: "rejected" };
  }
  return { protocol_version: 1, status: "retryable_error", code: "runtime_unavailable" };
}

export class HermesWebhookAdapter implements WakeAdapter {
  private readonly url: URL;
  private readonly healthUrl: URL;
  private readonly secret: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(options: HermesWebhookOptions) {
    this.url = safeRuntimeUrl(options.url);
    this.healthUrl = options.healthUrl
      ? safeRuntimeUrl(options.healthUrl)
      : new URL("/health", this.url);
    if (options.secret.length === 0) throw new Error("Hermes webhook secret is required");
    this.secret = options.secret;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async health(signal: AbortSignal): Promise<HealthResult> {
    try {
      const response = await this.fetch(this.healthUrl, {
        method: "GET",
        redirect: "error",
        signal,
      });
      await discardBody(response);
      return response.ok
        ? { healthy: true }
        : { healthy: false, detailCode: "runtime_unavailable" };
    } catch {
      return { healthy: false, detailCode: "runtime_unavailable" };
    }
  }

  async wake(input: WakeInput, signal: AbortSignal): Promise<WakeResponse> {
    const deliveryId = idSchema.parse(input.deliveryId);
    const body = JSON.stringify({ delivery_id: deliveryId });
    const timestamp = String(Math.floor(this.now() / 1_000));
    const signature = createHmac("sha256", this.secret)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": deliveryId,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature-v2": signature,
      },
      body,
      redirect: "error",
      signal,
    });

    if (response.status === 202) {
      const parsed = acceptedSchema.parse(await readJson(response));
      if (parsed.delivery_id !== deliveryId)
        throw new Error("Runtime returned a different delivery ID");
      return { protocol_version: 1, status: "accepted" };
    }
    if (response.status === 200) {
      const parsed = duplicateSchema.parse(await readJson(response));
      if (parsed.delivery_id !== deliveryId)
        throw new Error("Runtime returned a different delivery ID");
      return { protocol_version: 1, status: "duplicate" };
    }
    await discardBody(response);
    return statusResult(response);
  }
}
