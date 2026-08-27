import { createHmac, randomUUID } from "node:crypto";
import type {
  DevelopmentVerboseBoundary,
  DevelopmentVerboseTranscript,
} from "./development-verbose.js";
import { requestTimeout, withDeadline } from "./http.js";
import { LocalToolResultTooLarge, serializeLocalToolResult } from "./local-tool-result.js";
import { assertSafeUpstreamResult } from "./mcp-contract.js";
import { type NotificationJournal, validateNotificationId } from "./notification-journal.js";

const POLL_DEADLINE_MS = 40_000;
const WEBHOOK_DEADLINE_MS = 10_000;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;
const ACCEPTED_REDRIVE_MS = 60_000;
const IDLE_INTERVAL_MS = 1_000;
const POLL_RETRY_MS = 1_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_STRUCTURAL_TOKENS = 16_384;
const MAX_MESSAGES_PER_POLL = 256;
const MAX_LOCAL_POLL_SECONDS = 30;

export type NotificationFetch = (url: URL, init: RequestInit) => Promise<Response>;
export type McpNotificationPoll = (signal: AbortSignal) => Promise<Record<string, unknown>>;

export type NotificationRelayErrorCode =
  | "already_running"
  | "central_authentication_failed"
  | "central_redirect_rejected"
  | "invalid_configuration"
  | "invalid_notification_response"
  | "journal_failed"
  | "notification_response_too_large"
  | "relay_failed";

export class NotificationRelayError extends Error {
  constructor(
    readonly code: NotificationRelayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NotificationRelayError";
  }
}

export interface NotificationRelayOptions {
  journal: NotificationJournal;
  centralApiUrl: string | URL;
  centralToken: string;
  webhookUrl: string | URL;
  webhookToken: string;
  fetch?: NotificationFetch;
  pollMessagesThroughMcp?: McpNotificationPoll;
  now?: () => number;
  random?: () => number;
  pollDeadlineMs?: number;
  webhookDeadlineMs?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  acceptedRedriveMs?: number;
  idleIntervalMs?: number;
  pollRetryMs?: number;
  verboseTranscript?: DevelopmentVerboseTranscript;
}

interface ParsedMessage {
  message: Record<string, unknown>;
  serialized: string;
  id?: string;
}

interface PollResponse {
  messages: ParsedMessage[];
}

interface BufferedMessage extends ParsedMessage {
  wakeId: string;
}

interface VolatileWake {
  wakeId: string;
  state: "pending" | "in_flight" | "retry_wait";
  attemptCount: number;
  nextAttemptAtMs?: number;
  mayHaveReachedWebhook: boolean;
}

interface WakeClaim {
  wakeId: string;
  centralId?: string;
  attemptCount: number;
  mayHaveReachedWebhook: boolean;
  volatile: boolean;
}

class RequestFailed extends Error {}
class RequestCancelled extends Error {}
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
    throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
  }
}

function safeToken(value: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidPollResponse(): never {
  throw new NotificationRelayError(
    "invalid_notification_response",
    "Central notification response is invalid",
  );
}

function oversizedPollResponse(): never {
  throw new NotificationRelayError(
    "notification_response_too_large",
    "Central notification response exceeded its size limit",
  );
}

function scanJsonStructure(bytes: Uint8Array): void {
  const containers: number[] = [];
  let escaped = false;
  let inString = false;
  let structuralTokens = 0;

  for (const byte of bytes) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === 0x5c) {
        escaped = true;
      } else if (byte === 0x22) {
        inString = false;
      }
      continue;
    }

    if (byte === 0x22) {
      inString = true;
      structuralTokens += 1;
    } else if (byte === 0x7b || byte === 0x5b) {
      containers.push(byte);
      structuralTokens += 1;
      if (containers.length > MAX_JSON_DEPTH) invalidPollResponse();
    } else if (byte === 0x7d || byte === 0x5d) {
      const expected = byte === 0x7d ? 0x7b : 0x5b;
      if (containers.pop() !== expected) invalidPollResponse();
      structuralTokens += 1;
    } else if (byte === 0x2c || byte === 0x3a) {
      structuralTokens += 1;
    }

    if (structuralTokens > MAX_JSON_STRUCTURAL_TOKENS) invalidPollResponse();
  }
  if (inString || escaped || containers.length !== 0) invalidPollResponse();
}

function assertBoundedJsonDepth(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > MAX_JSON_DEPTH) invalidPollResponse();
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      invalidPollResponse();
    }
    if (Array.isArray(current.value)) {
      for (const nested of current.value) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      for (const nested of Object.values(current.value)) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
}

function parsePollResponse(bytes: Uint8Array, centralToken: string): PollResponse {
  scanJsonStructure(bytes);
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    invalidPollResponse();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, ["messages"])
  ) {
    invalidPollResponse();
  }

  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) invalidPollResponse();
  if (messages.length > MAX_MESSAGES_PER_POLL) invalidPollResponse();

  const validated: ParsedMessage[] = [];
  const ids = new Map<string, string>();
  for (const item of messages) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      invalidPollResponse();
    }
    assertBoundedJsonDepth(item);
    try {
      assertSafeUpstreamResult(item, centralToken);
    } catch {
      invalidPollResponse();
    }

    let id: string | undefined;
    if (Object.hasOwn(item, "id")) {
      try {
        id = validateNotificationId((item as { id?: unknown }).id);
      } catch {
        invalidPollResponse();
      }
    }
    const message = item as Record<string, unknown>;
    const serialized = JSON.stringify(message);
    if (id !== undefined) {
      const existing = ids.get(id);
      if (existing !== undefined) {
        if (existing !== serialized) invalidPollResponse();
        continue;
      }
      ids.set(id, serialized);
    }
    validated.push({ message, serialized, ...(id === undefined ? {} : { id }) });
  }
  try {
    serializeLocalToolResult({ messages: validated.map(({ message }) => message) });
  } catch (error) {
    if (error instanceof LocalToolResultTooLarge) oversizedPollResponse();
    invalidPollResponse();
  }
  return { messages: validated };
}

function parseMcpPollResponse(value: Record<string, unknown>, centralToken: string): PollResponse {
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    invalidPollResponse();
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) oversizedPollResponse();
  return parsePollResponse(bytes, centralToken);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Remote response details are intentionally discarded.
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new ResponseTooLarge();
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative if remote cancellation also fails.
        }
        throw new ResponseTooLarge();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ResponseTooLarge) throw error;
    throw new RequestFailed();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function safeRunError(error: unknown): NotificationRelayError {
  return error instanceof NotificationRelayError
    ? error
    : new NotificationRelayError("relay_failed", "Notification relay failed");
}

export class NotificationRelay {
  private readonly journal: NotificationJournal;
  private readonly centralPollUrl: URL;
  private readonly centralToken: string;
  private readonly centralAuthorization: string;
  private readonly webhookUrl: URL;
  private readonly webhookToken: string;
  private readonly webhookAuthorization: string;
  private readonly request: NotificationFetch;
  private readonly pollMessagesThroughMcp: McpNotificationPoll | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pollDeadlineMs: number;
  private readonly webhookDeadlineMs: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly acceptedRedriveMs: number;
  private readonly idleIntervalMs: number;
  private readonly pollRetryMs: number;
  private readonly verboseTranscript: DevelopmentVerboseTranscript | undefined;
  private readonly inbox: BufferedMessage[] = [];
  private readonly volatileWakes = new Map<string, VolatileWake>();
  private readonly waiters = new Set<() => void>();
  private revision = 0;
  private runController: AbortController | undefined;
  private running: Promise<void> | undefined;
  private shutdownRequested = false;
  private useMcpPolling = false;

  constructor(options: NotificationRelayOptions) {
    this.journal = options.journal;
    const centralApiUrl = safeUrl(options.centralApiUrl);
    this.centralPollUrl = new URL("/api/poll_messages?timeout=30", centralApiUrl);
    this.centralToken = safeToken(options.centralToken);
    this.centralAuthorization = `Bearer ${this.centralToken}`;
    this.webhookUrl = safeUrl(options.webhookUrl);
    this.webhookToken = safeToken(options.webhookToken);
    this.webhookAuthorization = `Bearer ${this.webhookToken}`;
    this.request = options.fetch ?? fetch;
    this.pollMessagesThroughMcp = options.pollMessagesThroughMcp;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.pollDeadlineMs = requestTimeout(
      options.pollDeadlineMs,
      POLL_DEADLINE_MS,
      "pollDeadlineMs",
    );
    this.webhookDeadlineMs = requestTimeout(
      options.webhookDeadlineMs,
      WEBHOOK_DEADLINE_MS,
      "webhookDeadlineMs",
    );
    this.retryBaseMs = requestTimeout(options.retryBaseMs, RETRY_BASE_MS, "retryBaseMs");
    this.retryCapMs = requestTimeout(options.retryCapMs, RETRY_CAP_MS, "retryCapMs");
    this.acceptedRedriveMs = requestTimeout(
      options.acceptedRedriveMs,
      ACCEPTED_REDRIVE_MS,
      "acceptedRedriveMs",
    );
    this.idleIntervalMs = requestTimeout(
      options.idleIntervalMs,
      IDLE_INTERVAL_MS,
      "idleIntervalMs",
    );
    this.pollRetryMs = requestTimeout(options.pollRetryMs, POLL_RETRY_MS, "pollRetryMs");
    this.verboseTranscript = options.verboseTranscript;
    if (this.retryCapMs < this.retryBaseMs) {
      throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
    }
  }

  run(signal: AbortSignal): Promise<void> {
    if (this.running !== undefined) {
      throw new NotificationRelayError("already_running", "Notification relay is already running");
    }
    const controller = new AbortController();
    this.runController = controller;
    this.shutdownRequested = false;
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    const running = this.execute(combinedSignal, signal, controller).finally(() => {
      if (this.running === running) {
        this.running = undefined;
        this.runController = undefined;
      }
    });
    this.running = running;
    return running;
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.runController?.abort();
    this.notifyWork();
    await this.running;
  }

  async pollMessages(
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > MAX_LOCAL_POLL_SECONDS
    ) {
      throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
    }
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (this.inbox.length === 0 && !signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.wait(remaining, signal, this.revision);
    }
    if (signal.aborted) throw new RequestCancelled();

    const messages = this.inbox.map(({ message }) => message);
    let removed = false;
    for (let index = this.inbox.length - 1; index >= 0; index -= 1) {
      const item = this.inbox[index];
      if (item?.id !== undefined) continue;
      this.inbox.splice(index, 1);
      removed = true;
    }
    if (removed) this.notifyWork();
    return { messages };
  }

  /** Call only after the central ack_message operation has returned success. */
  confirmContentAcknowledgement(messageId: string): boolean {
    try {
      const confirmed = this.journal.confirmContentAcknowledgement(messageId);
      if (confirmed) {
        for (let index = this.inbox.length - 1; index >= 0; index -= 1) {
          if (this.inbox[index]?.id === messageId) this.inbox.splice(index, 1);
        }
        this.notifyWork();
      }
      return confirmed;
    } catch {
      throw new NotificationRelayError("journal_failed", "Notification journal operation failed");
    }
  }

  private async execute(
    signal: AbortSignal,
    callerSignal: AbortSignal,
    controller: AbortController,
  ): Promise<void> {
    if (signal.aborted) return;
    try {
      this.journalOperation(() => this.journal.discardUnrecoverable());
      this.notifyWork();

      const loops = [this.pollLoop(signal), this.wakeLoop(signal)];
      try {
        await Promise.all(loops);
      } catch (error) {
        controller.abort();
        this.notifyWork();
        await Promise.allSettled(loops);
        if (callerSignal.aborted || this.shutdownRequested) return;
        throw safeRunError(error);
      }
    } catch (error) {
      if (callerSignal.aborted || this.shutdownRequested) return;
      throw safeRunError(error);
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const revision = this.revision;
      try {
        await this.pollOnce(signal);
        while ((this.inbox.length > 0 || this.volatileWakes.size > 0) && !signal.aborted) {
          await this.wait(this.idleIntervalMs, signal, this.revision);
        }
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        if (error instanceof NotificationRelayError) throw error;
        await this.wait(this.pollRetryMs, signal, revision);
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    if (this.useMcpPolling) {
      await this.pollOnceThroughMcp(signal);
      return;
    }
    const response = await this.fetchResponse(
      "central_rest",
      this.centralPollUrl,
      {
        method: "GET",
        headers: { Authorization: this.centralAuthorization },
      },
      this.pollDeadlineMs,
      signal,
    );
    if (response.status === 401) {
      await cancelBody(response);
      throw new NotificationRelayError(
        "central_authentication_failed",
        "Central authentication failed",
      );
    }
    if (isRedirect(response)) {
      await cancelBody(response);
      throw new NotificationRelayError(
        "central_redirect_rejected",
        "Central notification redirect was rejected",
      );
    }
    if (response.status === 404 && this.pollMessagesThroughMcp !== undefined) {
      await cancelBody(response);
      this.useMcpPolling = true;
      await this.pollOnceThroughMcp(signal);
      return;
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new RequestFailed();
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof ResponseTooLarge) {
        oversizedPollResponse();
      }
      throw error;
    }
    const poll = parsePollResponse(bytes, this.centralToken);
    this.ingestPoll(poll);
  }

  private async pollOnceThroughMcp(signal: AbortSignal): Promise<void> {
    const pollMessages = this.pollMessagesThroughMcp;
    if (pollMessages === undefined) {
      throw new NotificationRelayError("relay_failed", "Notification relay failed");
    }
    const result = await pollMessages(signal);
    this.ingestPoll(parseMcpPollResponse(result, this.centralToken));
  }

  private ingestPoll(poll: PollResponse): void {
    for (const item of poll.messages) {
      if (item.id === undefined) continue;
      const buffered = this.inbox.find((candidate) => candidate.id === item.id);
      if (buffered !== undefined && buffered.serialized !== item.serialized) invalidPollResponse();
    }

    const observedAt = this.currentTime();
    const ids = poll.messages.flatMap(({ id }) => (id === undefined ? [] : [id]));
    this.journalOperation(() => this.journal.ingest(ids, observedAt));
    for (const item of poll.messages) {
      if (item.id !== undefined) {
        const record = this.journalOperation(() => this.journal.get(item.id as string));
        if (
          record?.wakeState === "content_acknowledged" ||
          this.inbox.some((candidate) => candidate.id === item.id)
        ) {
          continue;
        }
        this.inbox.push({ ...item, wakeId: item.id });
        continue;
      }

      const wakeId = randomUUID();
      this.inbox.push({ ...item, wakeId });
      this.volatileWakes.set(wakeId, {
        wakeId,
        state: "pending",
        attemptCount: 0,
        nextAttemptAtMs: observedAt,
        mayHaveReachedWebhook: false,
      });
    }
    this.notifyWork();
  }

  private async wakeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const revision = this.revision;
      const now = this.currentTime();
      const claim = this.claimDueWake(now);
      if (claim === undefined) {
        await this.waitUntil(this.nextWakeAtMs(), now, signal, revision);
        continue;
      }

      let response: Response;
      try {
        const instruction =
          claim.centralId === undefined
            ? "An A2A message is ready. Use the A2A MCP tools to retrieve and process it."
            : `A2A message ${claim.centralId} is ready. Use the A2A MCP tools to retrieve and process it.`;
        const body = JSON.stringify({
          message: instruction,
          name: "A2A Gateway",
          deliver: false,
          wakeMode: "now",
        });
        const timestamp = String(Math.floor(this.currentTime() / 1_000));
        const signature = createHmac("sha256", this.webhookToken)
          .update(timestamp)
          .update(".")
          .update(body)
          .digest("hex");
        response = await this.fetchResponse(
          "webhook",
          this.webhookUrl,
          {
            method: "POST",
            headers: {
              Authorization: this.webhookAuthorization,
              "Idempotency-Key": claim.wakeId,
              "Content-Type": "application/json",
              "X-Request-ID": claim.wakeId,
              "X-Webhook-Timestamp": timestamp,
              "X-Webhook-Signature-V2": signature,
            },
            body,
          },
          this.webhookDeadlineMs,
          signal,
        );
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        this.scheduleWakeRetry(claim, true);
        continue;
      }

      if (!response.ok || isRedirect(response)) {
        await cancelBody(response);
        this.scheduleWakeRetry(claim, claim.mayHaveReachedWebhook);
        continue;
      }
      await cancelBody(response);
      if (claim.volatile) {
        this.volatileWakes.delete(claim.wakeId);
      } else {
        const nextAttemptAt = this.addTime(this.currentTime(), this.acceptedRedriveMs);
        this.journalOperation(() => this.journal.recordWakeAccepted(claim.wakeId, nextAttemptAt));
      }
      this.notifyWork();
    }
  }

  private claimDueWake(nowMs: number): WakeClaim | undefined {
    let volatile: VolatileWake | undefined;
    for (const candidate of this.volatileWakes.values()) {
      if (
        (candidate.state !== "pending" && candidate.state !== "retry_wait") ||
        candidate.nextAttemptAtMs === undefined ||
        candidate.nextAttemptAtMs > nowMs
      ) {
        continue;
      }
      if (
        volatile === undefined ||
        (volatile.nextAttemptAtMs as number) > candidate.nextAttemptAtMs ||
        (volatile.nextAttemptAtMs === candidate.nextAttemptAtMs &&
          volatile.wakeId.localeCompare(candidate.wakeId) > 0)
      ) {
        volatile = candidate;
      }
    }
    if (volatile !== undefined) {
      if (volatile.attemptCount === Number.MAX_SAFE_INTEGER) {
        throw new NotificationRelayError("relay_failed", "Notification relay failed");
      }
      volatile.state = "in_flight";
      volatile.attemptCount += 1;
      delete volatile.nextAttemptAtMs;
      return {
        wakeId: volatile.wakeId,
        attemptCount: volatile.attemptCount,
        mayHaveReachedWebhook: volatile.mayHaveReachedWebhook,
        volatile: true,
      };
    }

    const durable = this.journalOperation(() => this.journal.claimDueWake(nowMs));
    return durable === undefined
      ? undefined
      : {
          wakeId: durable.messageId,
          centralId: durable.messageId,
          attemptCount: durable.attemptCount,
          mayHaveReachedWebhook: durable.mayHaveReachedWebhook,
          volatile: false,
        };
  }

  private nextWakeAtMs(): number | null {
    const durable = this.journalOperation(() => this.journal.nextWakeAtMs());
    let volatile: number | null = null;
    for (const wake of this.volatileWakes.values()) {
      if (
        (wake.state === "pending" || wake.state === "retry_wait") &&
        wake.nextAttemptAtMs !== undefined &&
        (volatile === null || wake.nextAttemptAtMs < volatile)
      ) {
        volatile = wake.nextAttemptAtMs;
      }
    }
    if (durable === null) return volatile;
    if (volatile === null) return durable;
    return Math.min(durable, volatile);
  }

  private scheduleWakeRetry(claim: WakeClaim, mayHaveReachedWebhook: boolean): void {
    const nextAttemptAt = this.addTime(this.currentTime(), this.retryDelay(claim.attemptCount));
    if (claim.volatile) {
      const wake = this.volatileWakes.get(claim.wakeId);
      if (wake === undefined) return;
      if (wake.state !== "in_flight") {
        throw new NotificationRelayError("relay_failed", "Notification relay failed");
      }
      wake.state = "retry_wait";
      wake.nextAttemptAtMs = nextAttemptAt;
      wake.mayHaveReachedWebhook ||= mayHaveReachedWebhook;
    } else {
      this.journalOperation(() =>
        this.journal.recordWakeRetry(claim.wakeId, nextAttemptAt, mayHaveReachedWebhook),
      );
    }
    this.notifyWork();
  }

  private async fetchResponse(
    boundary: DevelopmentVerboseBoundary,
    url: URL,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const requestSignal = withDeadline(signal, timeoutMs);
    const requestInit = {
      ...init,
      redirect: "manual" as const,
      signal: requestSignal,
    };
    this.verboseTranscript?.recordHttpRequest(boundary, url, requestInit);
    try {
      const response = await this.request(url, requestInit);
      return this.verboseTranscript?.wrapHttpResponse(boundary, response) ?? response;
    } catch (error) {
      this.verboseTranscript?.recordError(boundary, error);
      if (signal.aborted) throw new RequestCancelled();
      throw new RequestFailed();
    }
  }

  private retryDelay(attemptCount: number): number {
    const random = this.random();
    if (typeof random !== "number" || !Number.isFinite(random) || random < 0 || random >= 1) {
      throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
    }
    const exponent = Math.min(52, Math.max(0, attemptCount - 1));
    const capped = Math.min(this.retryCapMs, this.retryBaseMs * 2 ** exponent);
    return Math.max(1, Math.floor(capped / 2 + random * (capped / 2)));
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new NotificationRelayError("invalid_configuration", "Relay configuration is invalid");
    }
    return now;
  }

  private addTime(timestamp: number, duration: number): number {
    const result = timestamp + duration;
    if (!Number.isSafeInteger(result)) {
      throw new NotificationRelayError("relay_failed", "Notification relay failed");
    }
    return result;
  }

  private journalOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof NotificationRelayError) throw error;
      throw new NotificationRelayError("journal_failed", "Notification journal operation failed");
    }
  }

  private waitUntil(
    nextAtMs: number | null,
    nowMs: number,
    signal: AbortSignal,
    revision: number,
  ): Promise<void> {
    const delay =
      nextAtMs === null
        ? this.idleIntervalMs
        : Math.min(this.idleIntervalMs, Math.max(0, nextAtMs - nowMs));
    return this.wait(delay, signal, revision);
  }

  private wait(delayMs: number, signal: AbortSignal, revision: number): Promise<void> {
    if (signal.aborted || revision !== this.revision || delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      signal.addEventListener("abort", finish, { once: true });
      this.waiters.add(finish);
      if (revision !== this.revision) finish();
    });
  }

  private notifyWork(): void {
    this.revision += 1;
    for (const wake of [...this.waiters]) wake();
  }
}
