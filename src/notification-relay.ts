import { requestTimeout, withDeadline } from "./http.js";
import { type NotificationJournal, validateNotificationId } from "./notification-journal.js";

const POLL_DEADLINE_MS = 40_000;
const REMOTE_REQUEST_DEADLINE_MS = 10_000;
const WEBHOOK_DEADLINE_MS = 10_000;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;
const ACCEPTED_REDRIVE_MS = 60_000;
const IDLE_INTERVAL_MS = 1_000;
const POLL_RETRY_MS = 1_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type NotificationFetch = (url: URL, init: RequestInit) => Promise<Response>;

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
  now?: () => number;
  random?: () => number;
  pollDeadlineMs?: number;
  remoteRequestDeadlineMs?: number;
  webhookDeadlineMs?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  acceptedRedriveMs?: number;
  idleIntervalMs?: number;
  pollRetryMs?: number;
}

interface PollResponse {
  messages: Array<{ id: string }>;
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

function parsePollResponse(bytes: Uint8Array): PollResponse {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new NotificationRelayError(
      "invalid_notification_response",
      "Central notification response is invalid",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, ["messages"])
  ) {
    throw new NotificationRelayError(
      "invalid_notification_response",
      "Central notification response is invalid",
    );
  }

  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new NotificationRelayError(
      "invalid_notification_response",
      "Central notification response is invalid",
    );
  }
  const validated: Array<{ id: string }> = [];
  for (const item of messages) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !exactKeys(item as Record<string, unknown>, ["id"])
    ) {
      throw new NotificationRelayError(
        "invalid_notification_response",
        "Central notification response is invalid",
      );
    }
    try {
      validated.push({ id: validateNotificationId((item as { id?: unknown }).id) });
    } catch {
      throw new NotificationRelayError(
        "invalid_notification_response",
        "Central notification response is invalid",
      );
    }
  }
  return { messages: validated };
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
  private readonly centralAcknowledgementUrl: URL;
  private readonly centralAuthorization: string;
  private readonly webhookUrl: URL;
  private readonly webhookAuthorization: string;
  private readonly request: NotificationFetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pollDeadlineMs: number;
  private readonly remoteRequestDeadlineMs: number;
  private readonly webhookDeadlineMs: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly acceptedRedriveMs: number;
  private readonly idleIntervalMs: number;
  private readonly pollRetryMs: number;
  private readonly waiters = new Set<() => void>();
  private revision = 0;
  private runController: AbortController | undefined;
  private running: Promise<void> | undefined;
  private shutdownRequested = false;

  constructor(options: NotificationRelayOptions) {
    this.journal = options.journal;
    const centralApiUrl = safeUrl(options.centralApiUrl);
    this.centralPollUrl = new URL("/api/poll_messages?timeout=30&view=ids", centralApiUrl);
    this.centralAcknowledgementUrl = new URL("/api/ack_notification", centralApiUrl);
    this.centralAuthorization = `Bearer ${safeToken(options.centralToken)}`;
    this.webhookUrl = safeUrl(options.webhookUrl);
    this.webhookAuthorization = `Bearer ${safeToken(options.webhookToken)}`;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.pollDeadlineMs = requestTimeout(
      options.pollDeadlineMs,
      POLL_DEADLINE_MS,
      "pollDeadlineMs",
    );
    this.remoteRequestDeadlineMs = requestTimeout(
      options.remoteRequestDeadlineMs,
      REMOTE_REQUEST_DEADLINE_MS,
      "remoteRequestDeadlineMs",
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

  /** Call only after the central ack_message operation has returned success. */
  confirmContentAcknowledgement(messageId: string): boolean {
    try {
      const confirmed = this.journal.confirmContentAcknowledgement(messageId);
      if (confirmed) this.notifyWork();
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
      const recoveredAt = this.currentTime();
      this.journalOperation(() =>
        this.journal.recoverInFlight(recoveredAt, (count) =>
          this.addTime(recoveredAt, this.retryDelay(count)),
        ),
      );
      this.notifyWork();

      const loops = [
        this.pollLoop(signal),
        this.notificationAcknowledgementLoop(signal),
        this.wakeLoop(signal),
      ];
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
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        if (error instanceof NotificationRelayError) throw error;
        await this.wait(this.pollRetryMs, signal, revision);
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const response = await this.fetchResponse(
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
    if (!response.ok) {
      await cancelBody(response);
      throw new RequestFailed();
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof ResponseTooLarge) {
        throw new NotificationRelayError(
          "notification_response_too_large",
          "Central notification response exceeded its size limit",
        );
      }
      throw error;
    }
    const poll = parsePollResponse(bytes);
    const observedAt = this.currentTime();
    this.journalOperation(() =>
      this.journal.ingest(
        poll.messages.map(({ id }) => id),
        observedAt,
      ),
    );
    this.notifyWork();
  }

  private async notificationAcknowledgementLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const revision = this.revision;
      const now = this.currentTime();
      const claim = this.journalOperation(() =>
        this.journal.claimDueNotificationAcknowledgement(now),
      );
      if (claim === undefined) {
        const nextAt = this.journalOperation(() =>
          this.journal.nextNotificationAcknowledgementAtMs(),
        );
        await this.waitUntil(nextAt, now, signal, revision);
        continue;
      }

      let response: Response;
      try {
        response = await this.fetchResponse(
          this.centralAcknowledgementUrl,
          {
            method: "POST",
            headers: {
              Authorization: this.centralAuthorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message_id: claim.messageId }),
          },
          this.remoteRequestDeadlineMs,
          signal,
        );
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        this.scheduleNotificationAcknowledgementRetry(claim.messageId, claim.attemptCount);
        continue;
      }

      if (response.status === 401) {
        await cancelBody(response);
        throw new NotificationRelayError(
          "central_authentication_failed",
          "Central authentication failed",
        );
      }
      if (!response.ok || isRedirect(response)) {
        await cancelBody(response);
        this.scheduleNotificationAcknowledgementRetry(claim.messageId, claim.attemptCount);
        continue;
      }
      await cancelBody(response);
      this.journalOperation(() =>
        this.journal.recordNotificationAcknowledgementSuccess(claim.messageId),
      );
      this.notifyWork();
    }
  }

  private scheduleNotificationAcknowledgementRetry(messageId: string, attemptCount: number): void {
    const nextAttemptAt = this.addTime(this.currentTime(), this.retryDelay(attemptCount));
    this.journalOperation(() =>
      this.journal.recordNotificationAcknowledgementRetry(messageId, nextAttemptAt),
    );
    this.notifyWork();
  }

  private async wakeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const revision = this.revision;
      const now = this.currentTime();
      const claim = this.journalOperation(() => this.journal.claimDueWake(now));
      if (claim === undefined) {
        const nextAt = this.journalOperation(() => this.journal.nextWakeAtMs());
        await this.waitUntil(nextAt, now, signal, revision);
        continue;
      }

      let response: Response;
      try {
        response = await this.fetchResponse(
          this.webhookUrl,
          {
            method: "POST",
            headers: {
              Authorization: this.webhookAuthorization,
              "Idempotency-Key": claim.messageId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: `A2A message ${claim.messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
              name: "A2A Gateway",
              deliver: false,
              wakeMode: "now",
            }),
          },
          this.webhookDeadlineMs,
          signal,
        );
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        this.scheduleWakeRetry(claim.messageId, claim.attemptCount, true);
        continue;
      }

      if (!response.ok || isRedirect(response)) {
        await cancelBody(response);
        this.scheduleWakeRetry(claim.messageId, claim.attemptCount, claim.mayHaveReachedWebhook);
        continue;
      }
      await cancelBody(response);
      const nextAttemptAt = this.addTime(this.currentTime(), this.acceptedRedriveMs);
      this.journalOperation(() => this.journal.recordWakeAccepted(claim.messageId, nextAttemptAt));
      this.notifyWork();
    }
  }

  private scheduleWakeRetry(
    messageId: string,
    attemptCount: number,
    mayHaveReachedWebhook: boolean,
  ): void {
    const nextAttemptAt = this.addTime(this.currentTime(), this.retryDelay(attemptCount));
    this.journalOperation(() =>
      this.journal.recordWakeRetry(messageId, nextAttemptAt, mayHaveReachedWebhook),
    );
    this.notifyWork();
  }

  private async fetchResponse(
    url: URL,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const requestSignal = withDeadline(signal, timeoutMs);
    try {
      return await this.request(url, {
        ...init,
        redirect: "manual",
        signal: requestSignal,
      });
    } catch {
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
