import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { CentralMessage } from "./central-rest.js";
import { canonicalWebhookUrl } from "./delivery-profile.js";

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_MESSAGE_BYTES = 512 * 1024;

export type WebhookDeliveryErrorCode = "delivery_failed" | "invalid_configuration";

export class WebhookDeliveryError extends Error {
  constructor(readonly code: WebhookDeliveryErrorCode) {
    super("Webhook delivery failed");
    this.name = "WebhookDeliveryError";
  }
}

export interface WebhookDeliveryTargetOptions {
  readonly url: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly maximumAttempts?: number;
  readonly retryDelayMs?: number;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class WebhookDeliveryTarget {
  readonly #url: string;
  readonly #secret: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #deadlineMs: number;
  readonly #maximumAttempts: number;
  readonly #retryDelayMs: number;
  readonly #lifetime = new AbortController();

  constructor(options: WebhookDeliveryTargetOptions) {
    try {
      this.#url = canonicalWebhookUrl(options.url);
    } catch {
      throw new WebhookDeliveryError("invalid_configuration");
    }
    if (!/^[\x21-\x7e]{32,256}$/u.test(options.secret)) {
      throw new WebhookDeliveryError("invalid_configuration");
    }
    this.#secret = options.secret;
    this.#authorization = `Bearer ${options.secret}`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (
      !positiveInteger(this.#deadlineMs) ||
      !positiveInteger(this.#maximumAttempts) ||
      !positiveInteger(this.#retryDelayMs)
    ) {
      throw new WebhookDeliveryError("invalid_configuration");
    }
  }

  async deliver(
    message: CentralMessage,
    signal: AbortSignal,
  ): Promise<{ readonly status: "accepted" }> {
    let body: string;
    try {
      body = JSON.stringify(message);
    } catch {
      throw new WebhookDeliveryError("delivery_failed");
    }
    if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
      throw new WebhookDeliveryError("delivery_failed");
    }
    const requestId = message.id ?? randomUUID();
    const deadline = AbortSignal.timeout(this.#deadlineMs);
    const requestSignal = AbortSignal.any([signal, deadline, this.#lifetime.signal]);
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      if (requestSignal.aborted) throw new WebhookDeliveryError("delivery_failed");
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new WebhookDeliveryError("invalid_configuration");
      }
      const timestamp = String(Math.floor(now / 1_000));
      const signature = createHmac("sha256", this.#secret)
        .update(timestamp, "ascii")
        .update(".", "ascii")
        .update(body, "utf8")
        .digest("hex");
      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            authorization: this.#authorization,
            "content-type": "application/json",
            "idempotency-key": requestId,
            "x-request-id": requestId,
            "x-webhook-timestamp": timestamp,
            "x-webhook-signature-v2": signature,
          },
          body,
          credentials: "omit",
          redirect: "manual",
          signal: requestSignal,
        });
        const accepted = response.status >= 200 && response.status < 300;
        await cancel(response);
        if (accepted) return { status: "accepted" };
      } catch {
        if (requestSignal.aborted) throw new WebhookDeliveryError("delivery_failed");
      }
      if (attempt < this.#maximumAttempts) {
        try {
          await delay(this.#retryDelayMs, undefined, { signal: requestSignal });
        } catch {
          throw new WebhookDeliveryError("delivery_failed");
        }
      }
    }
    throw new WebhookDeliveryError("delivery_failed");
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
  }
}
