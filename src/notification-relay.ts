import { setTimeout as delay } from "node:timers/promises";

import type { CentralMessage } from "./central-rest.js";
import { type NotificationJournal, validateNotificationId } from "./notification-journal.js";

const MAX_MESSAGES = 256;
const MAX_RESULT_BYTES = 512 * 1024;
const DEFAULT_RETRY_DELAY_MS = 250;

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
  readonly journal: NotificationJournal;
  readonly deliveryTarget: DeliveryTarget;
  readonly receiveMessages: (signal: AbortSignal) => Promise<readonly CentralMessage[]>;
  readonly captureMessage?: (message: CentralMessage) => void | Promise<void>;
  readonly acknowledgeMessage: (messageId: string, signal: AbortSignal) => Promise<void>;
  readonly retryDelayMs?: number;
}

interface QueueItem {
  readonly message: CentralMessage;
  readonly serialized: string;
}

function validateMessage(value: CentralMessage): QueueItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationRelayError("invalid_notification_response");
  }
  if (value.id !== undefined) {
    try {
      validateNotificationId(value.id);
    } catch {
      throw new NotificationRelayError("invalid_notification_response");
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new NotificationRelayError("invalid_notification_response");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    throw new NotificationRelayError("invalid_notification_response");
  }
  return { message: value, serialized };
}

export class NotificationRelay {
  readonly #journal: NotificationJournal;
  readonly #deliveryTarget: DeliveryTarget;
  readonly #receiveMessages: NotificationRelayOptions["receiveMessages"];
  readonly #captureMessage: NonNullable<NotificationRelayOptions["captureMessage"]>;
  readonly #acknowledgeMessage: NotificationRelayOptions["acknowledgeMessage"];
  readonly #retryDelayMs: number;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;
  #closingTarget: Promise<void> | undefined;
  #shutdownRequested = false;

  constructor(options: NotificationRelayOptions) {
    this.#journal = options.journal;
    this.#deliveryTarget = options.deliveryTarget;
    this.#receiveMessages = options.receiveMessages;
    this.#captureMessage = options.captureMessage ?? (() => undefined);
    this.#acknowledgeMessage = options.acknowledgeMessage;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1) {
      throw new NotificationRelayError("invalid_configuration");
    }
  }

  run(signal: AbortSignal): Promise<void> {
    if (this.#running !== undefined) throw new NotificationRelayError("already_running");
    const controller = new AbortController();
    this.#controller = controller;
    this.#shutdownRequested = false;
    const combined = AbortSignal.any([signal, controller.signal]);
    const running = this.#execute(combined).finally(async () => {
      await this.#closeTarget();
      if (this.#running === running) {
        this.#running = undefined;
        this.#controller = undefined;
      }
    });
    this.#running = running;
    return running;
  }

  async shutdown(): Promise<void> {
    this.#shutdownRequested = true;
    this.#controller?.abort();
    await this.#closeTarget();
    await this.#running;
  }

  #closeTarget(): Promise<void> {
    this.#closingTarget ??= this.#deliveryTarget.close().catch(() => undefined);
    return this.#closingTarget;
  }

  async #execute(signal: AbortSignal): Promise<void> {
    try {
      this.#journal.discardUndelivered();
      for (const item of this.#journal.recoverableAcknowledgements()) {
        if (signal.aborted) return;
        await this.#acknowledge(item.messageId, signal);
      }
      while (!signal.aborted) {
        let messages: readonly CentralMessage[];
        try {
          messages = await this.#receiveMessages(signal);
        } catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof RetryableNotificationReceiveError)) throw error;
          const retryAfter = error.retryAfterMs ?? this.#retryDelayMs;
          if (!Number.isSafeInteger(retryAfter) || retryAfter < 1) {
            throw new NotificationRelayError("invalid_configuration");
          }
          await delay(retryAfter, undefined, { signal }).catch(() => undefined);
          continue;
        }
        if (messages.length > MAX_MESSAGES) {
          throw new NotificationRelayError("invalid_notification_response");
        }
        const queue = messages.map(validateMessage);
        if (
          Buffer.byteLength(
            JSON.stringify({ messages: queue.map(({ message }) => message) }),
            "utf8",
          ) > MAX_RESULT_BYTES
        ) {
          throw new NotificationRelayError("invalid_notification_response");
        }
        const byId = new Map<string, string>();
        const deliveryQueue: QueueItem[] = [];
        for (const item of queue) {
          if (item.message.id === undefined) {
            deliveryQueue.push(item);
            continue;
          }
          const prior = byId.get(item.message.id);
          if (prior !== undefined && prior !== item.serialized) {
            throw new NotificationRelayError("invalid_notification_response");
          }
          if (prior === undefined) deliveryQueue.push(item);
          byId.set(item.message.id, item.serialized);
        }
        try {
          this.#journal.ingest([...byId.keys()]);
        } catch {
          throw new NotificationRelayError("journal_failed");
        }
        for (const item of deliveryQueue) {
          if (signal.aborted) return;
          await this.#deliver(item.message, signal);
        }
      }
    } catch (error) {
      if (signal.aborted || this.#shutdownRequested) return;
      if (error instanceof NotificationRelayError) throw error;
      throw new NotificationRelayError("relay_failed", error);
    }
  }

  async #deliver(message: CentralMessage, signal: AbortSignal): Promise<void> {
    const id = message.id;
    if (id !== undefined) {
      const existing = this.#journal.get(id);
      if (existing?.deliveryState === "accepted" || existing?.deliveryState === "completed") {
        await this.#acknowledge(id, signal);
        return;
      }
    }
    await this.#captureMessage(message);
    if (id !== undefined) {
      try {
        this.#journal.beginDelivery(id);
      } catch {
        throw new NotificationRelayError("journal_failed");
      }
    }
    const result = await this.#deliveryTarget.deliver(message, signal);
    if (id === undefined) return;
    try {
      this.#journal.recordDelivered(id, result.status);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
    await this.#acknowledge(id, signal);
  }

  async #acknowledge(messageId: string, signal: AbortSignal): Promise<void> {
    try {
      this.#journal.beginAcknowledgement(messageId);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
    await this.#acknowledgeMessage(messageId, signal);
    try {
      this.#journal.removeAcknowledged(messageId);
    } catch {
      throw new NotificationRelayError("journal_failed");
    }
  }
}
