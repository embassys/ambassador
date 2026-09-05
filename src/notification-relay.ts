import { setTimeout as delay } from "node:timers/promises";
import type { CentralMessage } from "./central-rest.js";
import type { NotificationStore } from "./notification-store.js";

export type DeliveryResult = { readonly status: "accepted" | "completed" };
export interface DeliveryTarget {
  deliver(message: CentralMessage, signal: AbortSignal): Promise<DeliveryResult>;
  close(): Promise<void>;
}
export type NotificationRelayErrorCode =
  | "already_running"
  | "invalid_configuration"
  | "invalid_notification_response"
  | "journal_failed"
  | "relay_failed";
export class NotificationRelayError extends Error {
  constructor(
    readonly code: NotificationRelayErrorCode,
    cause?: unknown,
  ) {
    super("Notification relay failed", { cause });
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
  readonly store: NotificationStore;
  readonly deliveryTarget: DeliveryTarget;
  readonly receiveMessages: (signal: AbortSignal) => Promise<readonly CentralMessage[]>;
  /** False means a control event or a result already routed to its operation. */
  readonly captureMessage?: (
    message: CentralMessage,
  ) => boolean | undefined | Promise<boolean | undefined>;
  readonly acknowledgeMessage: (messageId: string, signal: AbortSignal) => Promise<void>;
  readonly onDeliveryError?: (error: unknown) => void;
  readonly onAcknowledgementError?: (error: unknown, messageId: string) => void;
  readonly retryDelayMs?: number;
}

export class NotificationRelay {
  readonly #options: NotificationRelayOptions;
  readonly #retryDelayMs: number;
  readonly #waiting = new Set<() => void>();
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;
  #closingTarget: Promise<void> | undefined;

  constructor(options: NotificationRelayOptions) {
    this.#options = options;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1)
      throw new NotificationRelayError("invalid_configuration");
  }
  run(signal: AbortSignal): Promise<void> {
    if (this.#running !== undefined) throw new NotificationRelayError("already_running");
    const controller = new AbortController();
    this.#controller = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    const running = this.#run(combined).finally(async () => {
      await this.#closeTarget();
      this.#wake();
      this.#running = undefined;
      this.#controller = undefined;
    });
    this.#running = running;
    return running;
  }
  notifyStoredWork(): void {
    this.#wake();
  }
  async shutdown(): Promise<void> {
    this.#controller?.abort();
    this.#wake();
    await this.#closeTarget();
    await this.#running;
  }
  #closeTarget(): Promise<void> {
    this.#closingTarget ??= this.#options.deliveryTarget.close().catch(() => undefined);
    return this.#closingTarget;
  }
  #wake(): void {
    for (const resume of [...this.#waiting]) resume();
  }
  #wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.#waiting.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#waiting.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#options.store.recover())
      await delay(0, undefined, { signal }).catch(() => undefined);
    const workers = [
      this.#receive(signal),
      this.#process(signal),
      this.#deliver(signal),
      this.#acknowledge(signal),
    ];
    const outcomes = await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          await worker;
        } catch (error) {
          if (signal.aborted) return;
          this.#controller?.abort();
          this.#wake();
          await this.#closeTarget();
          throw error;
        }
      }),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") {
      if (failure.reason instanceof NotificationRelayError) throw failure.reason;
      throw new NotificationRelayError("relay_failed", failure.reason);
    }
  }
  async #receive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let messages: readonly CentralMessage[];
      try {
        messages = await this.#options.receiveMessages(signal);
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof RetryableNotificationReceiveError)) throw error;
        const timeout = error.retryAfterMs ?? this.#retryDelayMs;
        if (!Number.isSafeInteger(timeout) || timeout < 1)
          throw new NotificationRelayError("invalid_configuration");
        await delay(timeout, undefined, { signal }).catch(() => undefined);
        continue;
      }
      if (signal.aborted) return;
      try {
        this.#options.store.ingest(messages);
      } catch (error) {
        throw new NotificationRelayError("invalid_notification_response", error);
      }
      this.#wake();
      // Central normally holds an empty poll; avoid a hot loop if it returns immediately.
      if (messages.length === 0)
        await delay(this.#retryDelayMs, undefined, { signal }).catch(() => undefined);
    }
  }
  async #process(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const record = this.#options.store.next("process");
      if (record === undefined) {
        await this.#wait(signal);
        continue;
      }
      if (record.message === undefined) throw new NotificationRelayError("journal_failed");
      const deliver = await this.#options.captureMessage?.(record.message);
      if (signal.aborted) return;
      this.#options.store.processed(record.id, deliver !== false);
      this.#wake();
    }
  }
  async #deliver(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const record = this.#options.store.next("deliver");
      if (record === undefined) {
        await this.#wait(signal);
        continue;
      }
      if (record.message === undefined) throw new NotificationRelayError("journal_failed");
      this.#options.store.beginDelivery(record.id);
      try {
        await this.#options.deliveryTarget.deliver(record.message, signal);
      } catch (error) {
        this.#options.store.deliveryUncertain(record.id);
        if (signal.aborted) return;
        this.#options.onDeliveryError?.(error);
        await this.#closeTarget();
        // Repair/restart may retry prepared work. This invocation cannot replay.
        while (!signal.aborted) await this.#wait(signal);
        return;
      }
      this.#options.store.delivered(record.id);
      this.#wake();
    }
  }
  async #acknowledge(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const record = this.#options.store.next("ack");
      if (record === undefined) {
        await this.#wait(signal);
        continue;
      }
      this.#options.store.beginAcknowledgement(record.id);
      try {
        await this.#options.acknowledgeMessage(record.id, signal);
      } catch (error) {
        this.#options.store.acknowledgementUncertain(record.id);
        if (signal.aborted) return;
        this.#options.onAcknowledgementError?.(error, record.id);
        continue;
      }
      this.#options.store.acknowledged(record.id);
      this.#wake();
    }
  }
}
