import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { WebhookAgentCapability } from "./agent-capabilities.js";
import { readCentralJson } from "./central-json.js";
import type { CentralMessage } from "./central-rest.js";
import { canonicalWebhookUrl } from "./delivery-profile.js";
import { buildDeliveryPrompt } from "./delivery-prompt.js";
import { finishResponseTrace } from "./verbose-log.js";

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_CANONICAL_MESSAGE_BYTES = 512 * 1024;
const MAX_OPENCLAW_REQUEST_BYTES = 256 * 1024;
const MAX_OPENCLAW_RESPONSE_BYTES = 16 * 1024;
const OPENCLAW_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPENCLAW_RUN_ID = /^[\x21-\x7e]{1,256}$/u;

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
  readonly contract: WebhookAgentCapability;
  readonly identityScope?: string;
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
  try {
    await readCentralJson(response, MAX_OPENCLAW_RESPONSE_BYTES);
  } catch {
    finishResponseTrace(response, undefined);
  }
  await response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function openClawAccepted(response: Response): Promise<boolean> {
  if (response.status !== 200) {
    await cancel(response);
    return false;
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_OPENCLAW_RESPONSE_BYTES)) ||
    response.body === null
  ) {
    await cancel(response);
    return false;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_OPENCLAW_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      chunks.push(next.value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    const parsed = JSON.parse(body) as unknown;
    finishResponseTrace(response, parsed, bytes);
    return (
      isRecord(parsed) &&
      parsed.ok === true &&
      typeof parsed.runId === "string" &&
      OPENCLAW_RUN_ID.test(parsed.runId)
    );
  } catch {
    await reader.cancel().catch(() => undefined);
    return false;
  }
}

export class WebhookDeliveryTarget {
  readonly #url: string;
  readonly #secret: string;
  readonly #authorization: string;
  readonly #contract: WebhookAgentCapability;
  readonly #identityScope: string | undefined;
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
    if (
      options.contract.format !== "ambassador-hmac-v2" &&
      (options.contract.format !== "openclaw-agent" ||
        !OPENCLAW_AGENT_ID.test(options.contract.agentId))
    ) {
      throw new WebhookDeliveryError("invalid_configuration");
    }
    this.#contract = options.contract;
    this.#identityScope = options.identityScope;
    if (
      options.contract.format === "openclaw-agent" &&
      (typeof options.identityScope !== "string" ||
        options.identityScope.length === 0 ||
        options.identityScope.length > 256)
    ) {
      throw new WebhookDeliveryError("invalid_configuration");
    }
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
      if (
        this.#contract.format === "openclaw-agent" &&
        (typeof message.sender_agent_id !== "string" ||
          message.sender_agent_id.length === 0 ||
          message.sender_agent_id.length > 256)
      ) {
        throw new WebhookDeliveryError("delivery_failed");
      }
      body =
        this.#contract.format === "ambassador-hmac-v2"
          ? JSON.stringify(message)
          : JSON.stringify({
              message: buildDeliveryPrompt(message),
              name: "Embassys Ambassador",
              agentId: this.#contract.agentId,
              sessionMode: "persistent",
              sessionKey: `hook:ambassador:${createHash("sha256")
                .update(
                  JSON.stringify([
                    this.#identityScope,
                    this.#url,
                    this.#contract.agentId,
                    message.sender_agent_id,
                  ]),
                )
                .digest("hex")}`,
              deliver: false,
            });
    } catch {
      throw new WebhookDeliveryError("delivery_failed");
    }
    const maximumBodyBytes =
      this.#contract.format === "openclaw-agent"
        ? MAX_OPENCLAW_REQUEST_BYTES
        : MAX_CANONICAL_MESSAGE_BYTES;
    if (Buffer.byteLength(body, "utf8") > maximumBodyBytes) {
      throw new WebhookDeliveryError("delivery_failed");
    }
    const requestId = message.id ?? randomUUID();
    const deadline = AbortSignal.timeout(this.#deadlineMs);
    const requestSignal = AbortSignal.any([signal, deadline, this.#lifetime.signal]);
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      if (requestSignal.aborted) throw new WebhookDeliveryError("delivery_failed");
      const headers: Record<string, string> = {
        authorization: this.#authorization,
        "content-type": "application/json",
        "idempotency-key": requestId,
      };
      if (this.#contract.format === "ambassador-hmac-v2") {
        const now = this.#now();
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new WebhookDeliveryError("invalid_configuration");
        }
        const timestamp = String(Math.floor(now / 1_000));
        headers["x-request-id"] = requestId;
        headers["x-webhook-timestamp"] = timestamp;
        headers["x-webhook-signature-v2"] = createHmac("sha256", this.#secret)
          .update(timestamp, "ascii")
          .update(".", "ascii")
          .update(body, "utf8")
          .digest("hex");
      }
      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers,
          body,
          credentials: "omit",
          redirect: "manual",
          signal: requestSignal,
        });
        const accepted =
          this.#contract.format === "openclaw-agent"
            ? await openClawAccepted(response)
            : response.status >= 200 && response.status < 300;
        if (this.#contract.format === "ambassador-hmac-v2") await cancel(response);
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
