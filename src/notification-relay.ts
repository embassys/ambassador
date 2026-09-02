import { createHmac, randomUUID } from "node:crypto";

import type { CentralMessage } from "./central-rest.js";
import {
  type NotificationJournal,
  type NotificationWakeClaim,
  validateNotificationId,
} from "./notification-journal.js";

const WEBHOOK_DEADLINE_MS = 10_000;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;
const ACCEPTED_REDRIVE_MS = 60_000;
const IDLE_INTERVAL_MS = 250;
const EMPTY_POLL_RETRY_MS = 250;
const MAX_LOCAL_POLL_SECONDS = 60;
const MAX_MESSAGES = 256;
const MAX_RESULT_BYTES = 512 * 1024;

export type NotificationRelayErrorCode =
  | "already_running"
  | "invalid_configuration"
  | "invalid_notification_response"
  | "journal_failed"
  | "relay_failed";

export class NotificationRelayError extends Error {
  constructor(
    readonly code: NotificationRelayErrorCode,
    message = "Notification relay failed",
  ) {
    super(message);
    this.name = "NotificationRelayError";
  }
}

export class RetryableNotificationReceiveError extends Error {
  constructor(readonly retryAfterMs?: number) {
    super("Central receive may be retried");
    this.name = "RetryableNotificationReceiveError";
  }
}

export interface NotificationRelayOptions {
  readonly journal: NotificationJournal;
  readonly webhookUrl: string;
  readonly webhookToken: string;
  readonly receiveMessages: (signal: AbortSignal) => Promise<readonly CentralMessage[]>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly webhookDeadlineMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  readonly acceptedRedriveMs?: number;
  readonly idleIntervalMs?: number;
  readonly emptyPollRetryMs?: number;
}

interface InboxItem {
  readonly id?: string;
  readonly wakeId: string;
  readonly serialized: string;
  readonly message: CentralMessage;
}

interface VolatileWake {
  readonly wakeId: string;
  state: "pending" | "in_flight" | "retry_wait";
  attemptCount: number;
  nextAttemptAtMs?: number;
  mayHaveReachedWebhook: boolean;
}

interface WakeClaim {
  readonly wakeId: string;
  readonly centralId?: string;
  readonly attemptCount: number;
  readonly mayHaveReachedWebhook: boolean;
  readonly volatile: boolean;
}

class RequestCancelled extends Error {}

function requestTimeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new NotificationRelayError("invalid_configuration");
  }
  return result;
}

function webhookTarget(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new NotificationRelayError("invalid_configuration");
  }
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.hostname !== "127.0.0.1" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  ) {
    throw new NotificationRelayError("invalid_configuration");
  }
  return target;
}

function validateMessage(value: CentralMessage): InboxItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationRelayError("invalid_notification_response");
  }
  const id = value.id === undefined ? undefined : validateNotificationId(value.id);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new NotificationRelayError("invalid_notification_response");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    throw new NotificationRelayError("invalid_notification_response");
  }
  return {
    ...(id === undefined ? {} : { id }),
    wakeId: id ?? randomUUID(),
    serialized,
    message: value,
  };
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class NotificationRelay {
  readonly #journal: NotificationJournal;
  readonly #webhookUrl: URL;
  readonly #webhookToken: string;
  readonly #webhookAuthorization: string;
  readonly #receiveMessages: (signal: AbortSignal) => Promise<readonly CentralMessage[]>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #webhookDeadlineMs: number;
  readonly #retryBaseMs: number;
  readonly #retryCapMs: number;
  readonly #acceptedRedriveMs: number;
  readonly #idleIntervalMs: number;
  readonly #emptyPollRetryMs: number;
  readonly #inbox: InboxItem[] = [];
  readonly #volatileWakes = new Map<string, VolatileWake>();
  readonly #waiters = new Set<() => void>();
  #revision = 0;
  #runController: AbortController | undefined;
  #running: Promise<void> | undefined;
  #shutdownRequested = false;

  constructor(options: NotificationRelayOptions) {
    this.#journal = options.journal;
    this.#webhookUrl = webhookTarget(options.webhookUrl);
    this.#webhookToken = options.webhookToken;
    this.#webhookAuthorization = `Bearer ${options.webhookToken}`;
    this.#receiveMessages = options.receiveMessages;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#webhookDeadlineMs = requestTimeout(options.webhookDeadlineMs, WEBHOOK_DEADLINE_MS);
    this.#retryBaseMs = requestTimeout(options.retryBaseMs, RETRY_BASE_MS);
    this.#retryCapMs = requestTimeout(options.retryCapMs, RETRY_CAP_MS);
    this.#acceptedRedriveMs = requestTimeout(options.acceptedRedriveMs, ACCEPTED_REDRIVE_MS);
    this.#idleIntervalMs = requestTimeout(options.idleIntervalMs, IDLE_INTERVAL_MS);
    this.#emptyPollRetryMs = requestTimeout(options.emptyPollRetryMs, EMPTY_POLL_RETRY_MS);
    if (!/^[0-9a-f]{48}$/u.test(this.#webhookToken) || this.#retryCapMs < this.#retryBaseMs) {
      throw new NotificationRelayError("invalid_configuration");
    }
  }

  run(signal: AbortSignal): Promise<void> {
    if (this.#running !== undefined) throw new NotificationRelayError("already_running");
    const controller = new AbortController();
    this.#runController = controller;
    this.#shutdownRequested = false;
    const combined = AbortSignal.any([signal, controller.signal]);
    const running = this.#execute(combined, signal, controller).finally(() => {
      if (this.#running === running) {
        this.#running = undefined;
        this.#runController = undefined;
      }
    });
    this.#running = running;
    return running;
  }

  async shutdown(): Promise<void> {
    this.#shutdownRequested = true;
    this.#runController?.abort();
    this.#notify();
    await this.#running;
  }

  async pollMessages(
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<{ messages: CentralMessage[] }> {
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > MAX_LOCAL_POLL_SECONDS
    ) {
      throw new NotificationRelayError("invalid_configuration");
    }
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (this.#inbox.length === 0 && !signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#wait(remaining, signal, this.#revision);
    }
    if (signal.aborted) throw new RequestCancelled();
    const messages = this.#inbox.map((item) => item.message);
    for (let index = this.#inbox.length - 1; index >= 0; index -= 1) {
      const item = this.#inbox[index];
      if (item?.id !== undefined) continue;
      this.#inbox.splice(index, 1);
      this.#volatileWakes.delete(item?.wakeId ?? "");
    }
    this.#notify();
    return { messages };
  }

  hasCurrentMessage(messageId: string): boolean {
    return this.#inbox.some((item) => item.id === messageId);
  }

  confirmAcknowledgement(messageId: string): boolean {
    const id = validateNotificationId(messageId);
    const index = this.#inbox.findIndex((item) => item.id === id);
    if (index < 0) return false;
    let removed: boolean;
    try {
      removed = this.#journal.remove(id);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
    if (!removed) return false;
    this.#inbox.splice(index, 1);
    this.#notify();
    return true;
  }

  async #execute(
    signal: AbortSignal,
    callerSignal: AbortSignal,
    controller: AbortController,
  ): Promise<void> {
    try {
      try {
        this.#journal.discardAll();
      } catch {
        throw new NotificationRelayError("journal_failed");
      }
      const loops = [this.#pollLoop(signal), this.#wakeLoop(signal)];
      try {
        await Promise.all(loops);
      } catch (error) {
        controller.abort();
        this.#notify();
        await Promise.allSettled(loops);
        if (callerSignal.aborted || this.#shutdownRequested) return;
        if (error instanceof NotificationRelayError) throw error;
        throw new NotificationRelayError("relay_failed");
      }
    } catch (error) {
      if (callerSignal.aborted || this.#shutdownRequested) return;
      if (error instanceof NotificationRelayError) throw error;
      throw new NotificationRelayError("relay_failed");
    }
  }

  async #pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      while ((this.#inbox.length > 0 || this.#volatileWakes.size > 0) && !signal.aborted) {
        await this.#wait(this.#idleIntervalMs, signal, this.#revision);
      }
      if (signal.aborted) return;
      const revision = this.#revision;
      try {
        const messages = await this.#receiveMessages(signal);
        if (messages.length > MAX_MESSAGES) {
          throw new NotificationRelayError("invalid_notification_response");
        }
        const items = messages.map(validateMessage);
        const normalized = JSON.stringify({ messages: items.map((item) => item.message) });
        if (Buffer.byteLength(normalized, "utf8") > MAX_RESULT_BYTES) {
          throw new NotificationRelayError("invalid_notification_response");
        }
        this.#ingest(items);
        if (items.length === 0) await this.#wait(this.#emptyPollRetryMs, signal, revision);
      } catch (error) {
        if (signal.aborted || error instanceof RequestCancelled) return;
        if (error instanceof NotificationRelayError) throw error;
        const delay =
          error instanceof RetryableNotificationReceiveError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : this.#emptyPollRetryMs;
        await this.#wait(delay, signal, revision);
      }
    }
  }

  #ingest(items: readonly InboxItem[]): void {
    const byId = new Map<string, string>();
    for (const existing of this.#inbox) {
      if (existing.id !== undefined) byId.set(existing.id, existing.serialized);
    }
    for (const item of items) {
      if (item.id === undefined) continue;
      const serialized = byId.get(item.id);
      if (serialized !== undefined && serialized !== item.serialized) {
        throw new NotificationRelayError("invalid_notification_response");
      }
      byId.set(item.id, item.serialized);
    }
    const now = this.#currentTime();
    const ids = items.flatMap((item) => (item.id === undefined ? [] : [item.id]));
    try {
      this.#journal.ingest(ids, now);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
    for (const item of items) {
      if (item.id !== undefined) {
        if (!this.#inbox.some((candidate) => candidate.id === item.id)) this.#inbox.push(item);
      } else {
        this.#inbox.push(item);
        this.#volatileWakes.set(item.wakeId, {
          wakeId: item.wakeId,
          state: "pending",
          attemptCount: 0,
          nextAttemptAtMs: now,
          mayHaveReachedWebhook: false,
        });
      }
    }
    this.#notify();
  }

  async #wakeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const revision = this.#revision;
      const now = this.#currentTime();
      const claim = this.#claimWake(now);
      if (claim === undefined) {
        await this.#waitUntil(this.#nextWakeAt(), now, signal, revision);
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
        const timestamp = String(Math.floor(this.#currentTime() / 1_000));
        const signature = createHmac("sha256", this.#webhookToken)
          .update(timestamp)
          .update(".")
          .update(body)
          .digest("hex");
        response = await this.#fetch(this.#webhookUrl, {
          method: "POST",
          headers: {
            authorization: this.#webhookAuthorization,
            "content-type": "application/json",
            "idempotency-key": claim.wakeId,
            "x-request-id": claim.wakeId,
            "x-webhook-timestamp": timestamp,
            "x-webhook-signature-v2": signature,
          },
          body,
          credentials: "omit",
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.#webhookDeadlineMs)]),
        });
      } catch {
        if (signal.aborted) return;
        this.#scheduleRetry(claim, true);
        continue;
      }
      if (!response.ok || (response.status >= 300 && response.status < 400)) {
        await cancel(response);
        this.#scheduleRetry(claim, claim.mayHaveReachedWebhook);
        continue;
      }
      await cancel(response);
      if (claim.volatile) this.#volatileWakes.delete(claim.wakeId);
      else {
        try {
          this.#journal.recordWakeAccepted(
            claim.wakeId,
            this.#addTime(this.#currentTime(), this.#acceptedRedriveMs),
          );
        } catch {
          throw new NotificationRelayError("journal_failed");
        }
      }
      this.#notify();
    }
  }

  #claimWake(now: number): WakeClaim | undefined {
    let volatile: VolatileWake | undefined;
    for (const candidate of this.#volatileWakes.values()) {
      if (
        (candidate.state !== "pending" && candidate.state !== "retry_wait") ||
        candidate.nextAttemptAtMs === undefined ||
        candidate.nextAttemptAtMs > now
      ) {
        continue;
      }
      if (
        volatile === undefined ||
        (volatile.nextAttemptAtMs as number) > candidate.nextAttemptAtMs
      ) {
        volatile = candidate;
      }
    }
    if (volatile !== undefined) {
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
    let durable: NotificationWakeClaim | undefined;
    try {
      durable = this.#journal.claimDueWake(now);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
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

  #scheduleRetry(claim: WakeClaim, mayHaveReached: boolean): void {
    const next = this.#addTime(this.#currentTime(), this.#retryDelay(claim.attemptCount));
    if (claim.volatile) {
      const wake = this.#volatileWakes.get(claim.wakeId);
      if (wake === undefined || wake.state !== "in_flight") return;
      wake.state = "retry_wait";
      wake.nextAttemptAtMs = next;
      wake.mayHaveReachedWebhook ||= mayHaveReached;
    } else {
      try {
        this.#journal.recordWakeRetry(claim.wakeId, next, mayHaveReached);
      } catch {
        throw new NotificationRelayError("journal_failed");
      }
    }
    this.#notify();
  }

  #nextWakeAt(): number | null {
    let result: number | null;
    try {
      result = this.#journal.nextWakeAtMs();
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
    for (const wake of this.#volatileWakes.values()) {
      if (
        (wake.state === "pending" || wake.state === "retry_wait") &&
        wake.nextAttemptAtMs !== undefined &&
        (result === null || wake.nextAttemptAtMs < result)
      ) {
        result = wake.nextAttemptAtMs;
      }
    }
    return result;
  }

  #retryDelay(attemptCount: number): number {
    const random = this.#random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new NotificationRelayError("invalid_configuration");
    }
    const cap = Math.min(this.#retryCapMs, this.#retryBaseMs * 2 ** Math.min(52, attemptCount - 1));
    return Math.max(1, Math.floor(cap / 2 + random * (cap / 2)));
  }

  #currentTime(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new NotificationRelayError("invalid_configuration");
    }
    return now;
  }

  #addTime(value: number, duration: number): number {
    const result = value + duration;
    if (!Number.isSafeInteger(result)) throw new NotificationRelayError("relay_failed");
    return result;
  }

  #waitUntil(
    next: number | null,
    now: number,
    signal: AbortSignal,
    revision: number,
  ): Promise<void> {
    return this.#wait(
      next === null
        ? this.#idleIntervalMs
        : Math.min(this.#idleIntervalMs, Math.max(0, next - now)),
      signal,
      revision,
    );
  }

  #wait(delay: number, signal: AbortSignal, revision: number): Promise<void> {
    if (signal.aborted || revision !== this.#revision || delay <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.#waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
      this.#waiters.add(finish);
      if (revision !== this.#revision) finish();
    });
  }

  #notify(): void {
    this.#revision += 1;
    for (const waiter of [...this.#waiters]) waiter();
  }
}
