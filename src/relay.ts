import type { WakeAdapter } from "./adapters/types.js";
import { type AgentConfig, bindingFingerprint, type SidecarConfig } from "./config.js";
import { type ControllerClient, ControllerRequestError } from "./controller.js";
import type { Journal, RecordedWakeResult } from "./journal.js";
import { PROTOCOL_VERSION } from "./protocol.js";

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;
const OUTBOX_BATCH_SIZE = 1_000;

const RETRYABLE_REASONS = new Set([
  "runtime_unavailable",
  "rate_limited",
  "timeout",
  "outcome_unknown",
]);
const PERMANENT_REASONS = new Set([
  "unauthorized",
  "invalid_config",
  "unsupported_runtime",
  "rejected",
]);

export interface RelayOptions {
  config: SidecarConfig;
  journal: Journal;
  controller: ControllerClient;
  createAdapter: (agent: AgentConfig) => WakeAdapter;
  now?: () => number;
  random?: () => number;
}

export class Relay {
  private readonly config: SidecarConfig;
  private readonly journal: Journal;
  private readonly controller: ControllerClient;
  private readonly createAdapter: (agent: AgentConfig) => WakeAdapter;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly agents: Map<string, AgentConfig>;
  private readonly adapters = new Map<string, WakeAdapter>();

  constructor(options: RelayOptions) {
    this.config = options.config;
    this.journal = options.journal;
    this.controller = options.controller;
    this.createAdapter = options.createAdapter;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.agents = new Map(options.config.agents.map((agent) => [agent.binding_id, agent]));

    this.journal.recoverInFlight(this.now());
  }

  async runOnce(signal: AbortSignal): Promise<void> {
    this.journal.recoverInFlight(this.now());
    const attemptedOutboxIds = new Set<string>();
    const initial = await this.serviceDurableWork(signal, attemptedOutboxIds);
    if (initial.error !== null) throw initial.error;

    const remainingCapacity = this.config.controller.queue_capacity - this.journal.activeCount();
    if (remainingCapacity <= 0) return;

    const now = this.now();
    const nextActionAt = this.journal.nextActionAtMs();
    const millisecondsUntilAction = nextActionAt === null ? null : Math.max(0, nextActionAt - now);
    if (millisecondsUntilAction !== null && millisecondsUntilAction < 1_000) return;

    const waitSeconds =
      millisecondsUntilAction === null
        ? this.config.controller.poll_wait_seconds
        : Math.min(
            this.config.controller.poll_wait_seconds,
            Math.max(1, Math.floor(millisecondsUntilAction / 1_000)),
          );
    const poll = await this.controller.poll(this.journal.getCursor(), signal, {
      waitSeconds,
      maxNotifications: Math.min(this.config.controller.max_notifications, remainingCapacity),
    });
    this.journal.ingestPoll(
      poll.response,
      this.config.controller.queue_capacity,
      this.now(),
      poll.receivedAtMs,
    );

    const afterPoll = await this.serviceDurableWork(signal, attemptedOutboxIds);
    if (afterPoll.error !== null) throw afterPoll.error;
  }

  private async serviceDurableWork(
    signal: AbortSignal,
    attemptedOutboxIds: Set<string>,
  ): Promise<{ error: unknown | null; reportFailed: boolean }> {
    const initial = await this.flushOutbox(signal, attemptedOutboxIds);
    if (signal.aborted) return initial;

    const dueAtMs = this.now();
    this.journal.expireDue(dueAtMs);
    if (initial.error instanceof ControllerRequestError) {
      return initial;
    }

    const dueDeliveries = this.journal.listDue(dueAtMs, this.config.controller.queue_capacity);

    for (const dueDelivery of initial.reportFailed ? [] : dueDeliveries) {
      if (this.journal.hasPendingAcknowledgement(dueDelivery.deliveryId)) continue;
      const claimAtMs = this.now();
      if (dueDelivery.expiresAtMs <= claimAtMs) {
        this.journal.expireDue(claimAtMs);
        continue;
      }

      const agent = this.agents.get(dueDelivery.bindingId);
      if (agent === undefined) {
        this.journal.recordWakeResult(
          dueDelivery.deliveryId,
          { status: "failed", reason: "binding_not_found" },
          claimAtMs,
        );
        continue;
      }

      const claim = this.journal.claimDelivery(
        dueDelivery.deliveryId,
        bindingFingerprint(agent),
        claimAtMs,
      );
      if (claim.status !== "claimed" || claim.delivery === undefined) continue;

      let adapter = this.adapters.get(agent.binding_id);
      if (adapter === undefined) {
        try {
          adapter = this.createAdapter(agent);
          this.adapters.set(agent.binding_id, adapter);
        } catch {
          this.journal.recordWakeResult(
            claim.delivery.deliveryId,
            { status: "failed", reason: "invalid_config" },
            this.now(),
          );
          continue;
        }
      }

      let result: RecordedWakeResult;
      let observedAtMs: number;
      try {
        const response = await adapter.wake({ deliveryId: claim.delivery.deliveryId }, signal);
        observedAtMs = this.now();

        switch (response.status) {
          case "accepted":
          case "duplicate":
            result = {
              status: "accepted",
              ...(response.session_id === undefined ? {} : { sessionId: response.session_id }),
            };
            break;
          case "permanent_error":
            result = {
              status: "failed",
              reason: PERMANENT_REASONS.has(response.code) ? response.code : "rejected",
            };
            break;
          case "retryable_error": {
            const reason = RETRYABLE_REASONS.has(response.code)
              ? response.code
              : "runtime_unavailable";
            const mayHaveReachedRuntime =
              claim.delivery.mayHaveReachedRuntime ||
              reason === "timeout" ||
              reason === "outcome_unknown";
            if (observedAtMs >= claim.delivery.expiresAtMs) {
              result = mayHaveReachedRuntime
                ? {
                    status: "uncertain",
                    reason: "retry_window_exhausted",
                    mayHaveReachedRuntime: true,
                  }
                : { status: "expired" };
              break;
            }
            const cappedDelayMs = Math.min(
              RETRY_CAP_MS,
              RETRY_BASE_MS * 2 ** Math.max(0, claim.delivery.attemptCount - 1),
            );
            const retryDelayMs =
              response.retry_after_ms ??
              Math.floor(cappedDelayMs / 2 + this.random() * (cappedDelayMs / 2));
            result = {
              status: "retrying",
              reason,
              nextAttemptAtMs: Math.min(observedAtMs + retryDelayMs, claim.delivery.expiresAtMs),
              mayHaveReachedRuntime,
            };
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;

        observedAtMs = this.now();
        if (observedAtMs >= claim.delivery.expiresAtMs) {
          result = {
            status: "uncertain",
            reason: "retry_window_exhausted",
            mayHaveReachedRuntime: true,
          };
          this.journal.recordWakeResult(claim.delivery.deliveryId, result, observedAtMs);
          continue;
        }
        const cappedDelayMs = Math.min(
          RETRY_CAP_MS,
          RETRY_BASE_MS * 2 ** Math.max(0, claim.delivery.attemptCount - 1),
        );
        result = {
          status: "retrying",
          reason: "outcome_unknown",
          nextAttemptAtMs: Math.min(
            observedAtMs + Math.floor(cappedDelayMs / 2 + this.random() * (cappedDelayMs / 2)),
            claim.delivery.expiresAtMs,
          ),
          mayHaveReachedRuntime: true,
        };
      }

      this.journal.recordWakeResult(claim.delivery.deliveryId, result, observedAtMs);
    }

    if (initial.error !== null) return initial;

    const final = await this.flushOutbox(signal, attemptedOutboxIds);
    return {
      error: initial.error ?? final.error,
      reportFailed: initial.reportFailed || final.reportFailed,
    };
  }

  private async flushOutbox(
    signal: AbortSignal,
    attemptedOutboxIds: Set<string>,
  ): Promise<{ error: unknown | null; reportFailed: boolean }> {
    if (signal.aborted) {
      return { error: signal.reason ?? new Error("Relay was aborted"), reportFailed: false };
    }

    for (const record of this.journal.listOutbox(OUTBOX_BATCH_SIZE)) {
      if (signal.aborted) {
        return { error: signal.reason ?? new Error("Relay was aborted"), reportFailed: false };
      }
      if (attemptedOutboxIds.has(record.id)) continue;
      attemptedOutboxIds.add(record.id);

      try {
        this.journal.markOutboxAttempt(record.id);
        if (record.kind === "ack") {
          await this.controller.acknowledge(
            {
              protocol_version: PROTOCOL_VERSION,
              notification_id: record.notificationId,
              delivery_id: record.deliveryId,
              status: "persisted",
              persisted_at: record.persistedAt,
            },
            signal,
          );
        } else {
          await this.controller.report(
            {
              protocol_version: PROTOCOL_VERSION,
              report_id: record.id,
              sequence: record.sequence,
              notification_id: record.notificationId,
              delivery_id: record.deliveryId,
              status: record.status,
              ...(record.reason === undefined ? {} : { reason: record.reason }),
              observed_at: record.observedAt,
              ...(record.nextAttemptAt === undefined
                ? {}
                : { next_attempt_at: record.nextAttemptAt }),
            },
            signal,
          );
        }
        this.journal.confirmOutbox(record.id, this.now());
      } catch (error) {
        return { error, reportFailed: record.kind === "report" };
      }
    }

    return { error: null, reportFailed: false };
  }
}
