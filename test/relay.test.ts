import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HealthResult, WakeAdapter, WakeInput } from "../src/adapters/types.js";
import type { AgentConfig, SidecarConfig } from "../src/config.js";
import type { ControllerClient, PollRequestOptions } from "../src/controller.js";
import type {
  ClaimResult,
  DeliveryRecord,
  IngestResult,
  Journal,
  OutboxRecord,
  RecordedWakeResult,
} from "../src/journal.js";
import type {
  PersistenceAcknowledgement,
  PollResponse,
  WakeReport,
  WakeResponse,
} from "../src/protocol.js";
import { Relay } from "../src/relay.js";

const NOW_MS = Date.parse("2026-08-23T12:00:02Z");
const BINDING_ID = "binding_generic";
const DELIVERY_ID = "delivery_01J6YP";
const NOTIFICATION_ID = "notice_01J6YR";

const CONFIG: SidecarConfig = {
  version: 1,
  controller: {
    base_url: "https://controller.example",
    token: { source: "env", name: "A2A_CONTROLLER_TOKEN" },
    poll_wait_seconds: 30,
    max_notifications: 50,
    queue_capacity: 1_000,
  },
  agents: [
    {
      binding_id: BINDING_ID,
      adapter: {
        type: "generic",
        url: "http://127.0.0.1:8644/webhooks/a2a",
        secret: { source: "env", name: "A2A_RUNTIME_SECRET" },
      },
    },
  ],
};

function emptyPoll(cursor = "cursor_empty"): PollResponse {
  return {
    protocol_version: 1,
    cursor,
    server_time: new Date(NOW_MS).toISOString(),
    notifications: [],
  };
}

function notificationPoll(): PollResponse {
  return {
    protocol_version: 1,
    cursor: "cursor_01J6YR",
    server_time: new Date(NOW_MS).toISOString(),
    notifications: [
      {
        notification_id: NOTIFICATION_ID,
        delivery_id: DELIVERY_ID,
        binding_id: BINDING_ID,
        issued_at: new Date(NOW_MS - 1_000).toISOString(),
        expires_at: new Date(NOW_MS + 10 * 60_000).toISOString(),
      },
    ],
  };
}

function delivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    notificationId: NOTIFICATION_ID,
    deliveryId: DELIVERY_ID,
    bindingId: BINDING_ID,
    issuedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 10 * 60_000,
    state: "pending",
    attemptCount: 0,
    nextAttemptAtMs: NOW_MS,
    mayHaveReachedRuntime: false,
    reportSequence: 0,
    ...overrides,
  };
}

class MemoryJournal {
  cursor: string | null = null;
  readonly deliveries = new Map<string, DeliveryRecord>();
  readonly outbox = new Map<string, OutboxRecord>();
  readonly recordedResults: Array<{ deliveryId: string; result: RecordedWakeResult }> = [];
  readonly confirmed: string[] = [];
  failIngest = false;
  private nextReport = 1;

  constructor(
    private readonly trace: string[],
    deliveries: DeliveryRecord[] = [],
    outbox: OutboxRecord[] = [],
  ) {
    for (const record of deliveries) this.deliveries.set(record.deliveryId, record);
    for (const record of outbox) this.outbox.set(record.id, record);
  }

  close(): void {}

  ingestPoll(response: PollResponse, capacity: number, persistedAtMs: number): IngestResult {
    this.trace.push("journal.ingest");
    if (this.failIngest) throw new Error("simulated journal failure");

    const unseen = response.notifications.filter(
      (notification) => !this.deliveries.has(notification.delivery_id),
    );
    if (this.activeCount() + unseen.length > capacity) throw new Error("queue capacity exceeded");

    let inserted = 0;
    let duplicates = 0;
    for (const notification of response.notifications) {
      if (this.deliveries.has(notification.delivery_id)) {
        duplicates += 1;
        continue;
      }
      inserted += 1;
      const record = delivery({
        notificationId: notification.notification_id,
        deliveryId: notification.delivery_id,
        bindingId: notification.binding_id,
        issuedAtMs: Date.parse(notification.issued_at),
        expiresAtMs: Date.parse(notification.expires_at),
        nextAttemptAtMs: Date.parse(notification.issued_at),
      });
      this.deliveries.set(record.deliveryId, record);
      const ack: OutboxRecord = {
        id: `ack:${record.notificationId}`,
        kind: "ack",
        notificationId: record.notificationId,
        deliveryId: record.deliveryId,
        persistedAt: new Date(persistedAtMs).toISOString(),
      };
      this.outbox.set(ack.id, ack);
    }
    this.cursor = response.cursor;
    return { inserted, duplicates };
  }

  getCursor(): string | null {
    return this.cursor;
  }

  getControllerClockOffsetMs(): number {
    return 0;
  }

  getDelivery(deliveryId: string): DeliveryRecord | undefined {
    return this.deliveries.get(deliveryId);
  }

  listDue(nowMs: number, limit: number): DeliveryRecord[] {
    return [...this.deliveries.values()]
      .filter(
        (record) =>
          (record.state === "pending" || record.state === "retry_wait") &&
          record.nextAttemptAtMs <= nowMs &&
          record.expiresAtMs > nowMs,
      )
      .slice(0, limit);
  }

  claimDelivery(deliveryId: string, fingerprint: string, nowMs: number): ClaimResult {
    const record = this.deliveries.get(deliveryId);
    if (!record || record.nextAttemptAtMs > nowMs) return { status: "not_due" };
    if (
      record.bindingFingerprint !== undefined &&
      record.bindingFingerprint !== fingerprint &&
      record.mayHaveReachedRuntime
    ) {
      return { status: "binding_changed" };
    }
    record.bindingFingerprint ??= fingerprint;
    record.state = "waking";
    record.attemptCount += 1;
    return { status: "claimed", delivery: record };
  }

  recordWakeResult(deliveryId: string, result: RecordedWakeResult, observedAtMs: number): void {
    this.trace.push(`journal.record.${result.status}`);
    this.recordedResults.push({ deliveryId, result: { ...result } });
    const record = this.deliveries.get(deliveryId);
    if (!record) throw new Error(`unknown delivery ${deliveryId}`);

    record.state = result.status === "retrying" ? "retry_wait" : result.status;
    if (result.nextAttemptAtMs !== undefined) record.nextAttemptAtMs = result.nextAttemptAtMs;
    if (result.sessionId !== undefined) record.runtimeSessionId = result.sessionId;
    if (result.mayHaveReachedRuntime !== undefined) {
      record.mayHaveReachedRuntime = result.mayHaveReachedRuntime;
    }
    record.reportSequence += 1;
    const report: OutboxRecord = {
      id: `report_${this.nextReport++}`,
      kind: "report",
      notificationId: record.notificationId,
      deliveryId: record.deliveryId,
      sequence: record.reportSequence,
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      observedAt: new Date(observedAtMs).toISOString(),
      ...(result.nextAttemptAtMs === undefined
        ? {}
        : { nextAttemptAt: new Date(result.nextAttemptAtMs).toISOString() }),
    };
    this.outbox.set(report.id, report);
  }

  expireDue(nowMs: number): number {
    const expired = [...this.deliveries.values()].filter(
      (record) =>
        (record.state === "pending" || record.state === "retry_wait") &&
        record.expiresAtMs <= nowMs,
    );
    for (const record of expired) {
      this.recordWakeResult(
        record.deliveryId,
        record.mayHaveReachedRuntime
          ? { status: "uncertain", reason: "expired_after_attempt" }
          : { status: "expired" },
        nowMs,
      );
    }
    return expired.length;
  }

  recoverInFlight(nowMs: number): number {
    let recovered = 0;
    for (const record of this.deliveries.values()) {
      if (record.state !== "waking") continue;
      record.state = "retry_wait";
      record.nextAttemptAtMs = nowMs;
      record.mayHaveReachedRuntime = true;
      recovered += 1;
    }
    return recovered;
  }

  listOutbox(limit: number): OutboxRecord[] {
    return [...this.outbox.values()].slice(0, limit);
  }

  confirmOutbox(id: string, _confirmedAtMs: number): void {
    this.confirmed.push(id);
    this.outbox.delete(id);
  }

  activeCount(): number {
    return [...this.deliveries.values()].filter(
      (record) =>
        record.state === "pending" || record.state === "waking" || record.state === "retry_wait",
    ).length;
  }

  hasPendingAcknowledgement(deliveryId: string): boolean {
    return [...this.outbox.values()].some(
      (record) => record.kind === "ack" && record.deliveryId === deliveryId,
    );
  }

  nextActionAtMs(): number | null {
    const active = [...this.deliveries.values()].filter(
      (record) => record.state === "pending" || record.state === "retry_wait",
    );
    if (active.length === 0) return null;
    return Math.min(...active.flatMap((record) => [record.nextAttemptAtMs, record.expiresAtMs]));
  }
}

class RecordingController implements ControllerClient {
  readonly acknowledgements: PersistenceAcknowledgement[] = [];
  readonly reports: WakeReport[] = [];
  readonly cursors: Array<string | null> = [];
  readonly pollOptions: Array<PollRequestOptions | undefined> = [];
  failReports = 0;

  constructor(
    private readonly trace: string[],
    private readonly polls: PollResponse[] = [],
  ) {}

  async poll(
    cursor: string | null,
    _signal: AbortSignal,
    options?: PollRequestOptions,
  ): Promise<PollResponse> {
    this.trace.push("controller.poll");
    this.cursors.push(cursor);
    this.pollOptions.push(options);
    return this.polls.shift() ?? emptyPoll(`cursor_empty_${this.cursors.length}`);
  }

  async acknowledge(message: PersistenceAcknowledgement, _signal: AbortSignal): Promise<void> {
    this.trace.push("controller.ack");
    this.acknowledgements.push(message);
  }

  async report(message: WakeReport, _signal: AbortSignal): Promise<void> {
    this.trace.push(`controller.report.${message.status}`);
    this.reports.push({ ...message });
    if (this.failReports > 0) {
      this.failReports -= 1;
      throw new Error("simulated controller outage");
    }
  }
}

class ScriptedAdapter implements WakeAdapter {
  readonly inputs: WakeInput[] = [];

  constructor(
    private readonly trace: string[],
    private readonly responses: WakeResponse[],
    private readonly onWake?: () => void,
  ) {}

  async health(_signal: AbortSignal): Promise<HealthResult> {
    return { healthy: true };
  }

  async wake(input: WakeInput, _signal: AbortSignal): Promise<WakeResponse> {
    this.trace.push("adapter.wake");
    this.inputs.push({ ...input });
    this.onWake?.();
    const response = this.responses.shift();
    if (!response) throw new Error("no scripted wake response");
    return response;
  }
}

function createRelay(options: {
  journal: MemoryJournal;
  controller: RecordingController;
  adapter: ScriptedAdapter;
  now?: () => number;
  random?: () => number;
  config?: SidecarConfig;
  createAdapter?: (agent: AgentConfig) => WakeAdapter;
}): Relay {
  return new Relay({
    config: options.config ?? CONFIG,
    journal: options.journal as Journal,
    controller: options.controller,
    createAdapter: options.createAdapter ?? (() => options.adapter),
    now: options.now ?? (() => NOW_MS),
    random: options.random ?? (() => 0.5),
  });
}

describe("Relay", () => {
  test("acknowledges only after ingest, wakes, and reports acceptance", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace);
    const controller = new RecordingController(trace, [notificationPoll()]);
    const adapter = new ScriptedAdapter(trace, [
      { protocol_version: 1, status: "accepted", session_id: "local-session-42" },
    ]);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.ok(trace.indexOf("journal.ingest") < trace.indexOf("controller.ack"));
    assert.ok(trace.indexOf("journal.ingest") < trace.indexOf("adapter.wake"));
    assert.ok(trace.indexOf("adapter.wake") < trace.indexOf("controller.report.accepted"));
    assert.deepEqual(controller.acknowledgements, [
      {
        protocol_version: 1,
        notification_id: NOTIFICATION_ID,
        delivery_id: DELIVERY_ID,
        status: "persisted",
        persisted_at: new Date(NOW_MS).toISOString(),
      },
    ]);
    assert.deepEqual(adapter.inputs, [{ deliveryId: DELIVERY_ID }]);
    assert.equal(controller.reports.length, 1);
    assert.deepEqual(controller.reports[0], {
      protocol_version: 1,
      report_id: "report_1",
      sequence: 1,
      notification_id: NOTIFICATION_ID,
      delivery_id: DELIVERY_ID,
      status: "accepted",
      observed_at: new Date(NOW_MS).toISOString(),
    });
    assert.equal("session_id" in (controller.reports[0] ?? {}), false);
    assert.equal(journal.getDelivery(DELIVERY_ID)?.runtimeSessionId, "local-session-42");
  });

  test("does not acknowledge when atomic poll ingestion fails", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace);
    journal.failIngest = true;
    const controller = new RecordingController(trace, [notificationPoll()]);
    const adapter = new ScriptedAdapter(trace, []);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000)).catch(() => undefined);

    assert.deepEqual(controller.acknowledgements, []);
    assert.deepEqual(adapter.inputs, []);
    assert.equal(journal.getCursor(), null);
  });

  test("drains existing due work before an over-capacity poll is rejected", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery()]);
    const baseNotification = notificationPoll().notifications[0];
    assert.ok(baseNotification);
    const overCapacityPoll: PollResponse = {
      ...notificationPoll(),
      notifications: [
        { ...baseNotification, notification_id: "notification_2", delivery_id: "delivery_2" },
        { ...baseNotification, notification_id: "notification_3", delivery_id: "delivery_3" },
      ],
    };
    const controller = new RecordingController(trace, [overCapacityPoll]);
    const adapter = new ScriptedAdapter(trace, [
      { protocol_version: 1, status: "retryable_error", code: "runtime_unavailable" },
    ]);
    const relay = createRelay({
      journal,
      controller,
      adapter,
      config: {
        ...CONFIG,
        controller: { ...CONFIG.controller, queue_capacity: 2 },
      },
    });

    await relay.runOnce(AbortSignal.timeout(1_000)).catch(() => undefined);

    assert.deepEqual(adapter.inputs, [{ deliveryId: DELIVERY_ID }]);
    assert.equal(controller.reports[0]?.status, "retrying");
    assert.equal(journal.getCursor(), null);
  });

  test("shortens long polling so a scheduled retry is not delayed", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [
      delivery({ state: "retry_wait", nextAttemptAtMs: NOW_MS + 5_500 }),
    ]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, []);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.deepEqual(controller.pollOptions, [{ waitSeconds: 5, maxNotifications: 50 }]);
  });

  test("does not start another wake while report delivery is failing", async () => {
    const trace: string[] = [];
    const acceptedReport: OutboxRecord = {
      id: "report_blocking_1",
      kind: "report",
      notificationId: "notification_old",
      deliveryId: "delivery_old",
      sequence: 1,
      status: "accepted",
      observedAt: new Date(NOW_MS - 1_000).toISOString(),
    };
    const journal = new MemoryJournal(trace, [delivery()], [acceptedReport]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    controller.failReports = 1;
    const adapter = new ScriptedAdapter(trace, [{ protocol_version: 1, status: "accepted" }]);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000)).catch(() => undefined);

    assert.deepEqual(adapter.inputs, []);
    assert.equal(controller.cursors.length, 0);
    assert.equal(journal.getDelivery(DELIVERY_ID)?.state, "pending");
  });

  test("recovers a waking row at the start of the next in-process iteration", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery({ nextAttemptAtMs: NOW_MS + 60_000 })]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, [{ protocol_version: 1, status: "accepted" }]);
    const relay = createRelay({ journal, controller, adapter });
    const record = journal.getDelivery(DELIVERY_ID);
    assert.ok(record);
    record.state = "waking";

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.deepEqual(adapter.inputs, [{ deliveryId: DELIVERY_ID }]);
    assert.equal(record.state, "accepted");
  });

  test("retries the same delivery with injected deterministic jitter", async () => {
    const trace: string[] = [];
    let nowMs = NOW_MS;
    let randomCalls = 0;
    const journal = new MemoryJournal(trace, [delivery()]);
    const controller = new RecordingController(trace, [
      emptyPoll("cursor_1"),
      emptyPoll("cursor_2"),
    ]);
    const adapter = new ScriptedAdapter(trace, [
      { protocol_version: 1, status: "retryable_error", code: "runtime_unavailable" },
      { protocol_version: 1, status: "accepted" },
    ]);
    const relay = createRelay({
      journal,
      controller,
      adapter,
      now: () => nowMs,
      random: () => {
        randomCalls += 1;
        return 0.25;
      },
    });

    await relay.runOnce(AbortSignal.timeout(1_000));

    const retry = journal.recordedResults.find(({ result }) => result.status === "retrying");
    assert.ok(retry?.result.nextAttemptAtMs);
    assert.ok(retry.result.nextAttemptAtMs > NOW_MS);
    assert.equal(randomCalls, 1);
    assert.equal(controller.reports[0]?.status, "retrying");
    assert.equal(controller.reports[0]?.reason, "runtime_unavailable");

    nowMs = retry.result.nextAttemptAtMs;
    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.deepEqual(adapter.inputs, [{ deliveryId: DELIVERY_ID }, { deliveryId: DELIVERY_ID }]);
    assert.equal(controller.reports.at(-1)?.status, "accepted");
  });

  test("honors retry_after_ms exactly instead of applying jitter", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery()]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, [
      {
        protocol_version: 1,
        status: "retryable_error",
        code: "rate_limited",
        retry_after_ms: 5_000,
      },
    ]);
    const relay = createRelay({
      journal,
      controller,
      adapter,
      random: () => {
        throw new Error("jitter must not run when retry_after_ms is supplied");
      },
    });

    await relay.runOnce(AbortSignal.timeout(1_000));

    const retry = journal.recordedResults.find(({ result }) => result.status === "retrying");
    assert.equal(retry?.result.nextAttemptAtMs, NOW_MS + 5_000);
    assert.deepEqual(controller.reports[0], {
      protocol_version: 1,
      report_id: "report_1",
      sequence: 1,
      notification_id: NOTIFICATION_ID,
      delivery_id: DELIVERY_ID,
      status: "retrying",
      reason: "rate_limited",
      observed_at: new Date(NOW_MS).toISOString(),
      next_attempt_at: new Date(NOW_MS + 5_000).toISOString(),
    });
  });

  test("reports a retryable response received at expiry as terminal", async () => {
    const trace: string[] = [];
    let nowMs = NOW_MS;
    const expiresAtMs = NOW_MS + 100;
    const journal = new MemoryJournal(trace, [delivery({ expiresAtMs })]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(
      trace,
      [{ protocol_version: 1, status: "retryable_error", code: "runtime_unavailable" }],
      () => {
        nowMs = expiresAtMs;
      },
    );
    const relay = createRelay({ journal, controller, adapter, now: () => nowMs });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.equal(journal.getDelivery(DELIVERY_ID)?.state, "expired");
    assert.equal(controller.reports.at(-1)?.status, "expired");
    assert.equal(controller.reports.at(-1)?.reason, undefined);
  });

  test("records a permanent binding_not_found failure without calling an adapter", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery({ bindingId: "binding_missing" })]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, []);
    let adapterCreations = 0;
    const relay = createRelay({
      journal,
      controller,
      adapter,
      createAdapter: () => {
        adapterCreations += 1;
        return adapter;
      },
    });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.equal(adapterCreations, 0);
    assert.deepEqual(adapter.inputs, []);
    assert.equal(journal.getDelivery(DELIVERY_ID)?.state, "failed");
    assert.equal(controller.reports[0]?.status, "failed");
    assert.equal(controller.reports[0]?.reason, "binding_not_found");
  });

  test("records invalid_config when adapter construction fails instead of stranding waking work", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery()]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, []);
    const relay = createRelay({
      journal,
      controller,
      adapter,
      createAdapter: () => {
        throw new Error("missing runtime credential value must not be reported");
      },
    });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.equal(journal.getDelivery(DELIVERY_ID)?.state, "failed");
    assert.equal(journal.getDelivery(DELIVERY_ID)?.attemptCount, 1);
    assert.equal(controller.reports[0]?.status, "failed");
    assert.equal(controller.reports[0]?.reason, "invalid_config");
    assert.equal(JSON.stringify(controller.reports).includes("credential"), false);
  });

  test("expires a delivery before wake without contacting the runtime", async () => {
    const trace: string[] = [];
    const journal = new MemoryJournal(trace, [delivery({ expiresAtMs: NOW_MS })]);
    const controller = new RecordingController(trace, [emptyPoll()]);
    const adapter = new ScriptedAdapter(trace, []);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.deepEqual(adapter.inputs, []);
    assert.equal(journal.getDelivery(DELIVERY_ID)?.state, "expired");
    assert.equal(controller.reports[0]?.status, "expired");
    assert.equal(controller.reports[0]?.reason, undefined);
  });

  test("keeps and resends an identical accepted report after controller recovery", async () => {
    const trace: string[] = [];
    const acceptedReport: OutboxRecord = {
      id: "report_recovery_1",
      kind: "report",
      notificationId: NOTIFICATION_ID,
      deliveryId: DELIVERY_ID,
      sequence: 1,
      status: "accepted",
      observedAt: new Date(NOW_MS - 1_000).toISOString(),
    };
    const journal = new MemoryJournal(trace, [delivery({ state: "accepted" })], [acceptedReport]);
    const controller = new RecordingController(trace, [
      emptyPoll("cursor_1"),
      emptyPoll("cursor_2"),
    ]);
    controller.failReports = 1;
    const adapter = new ScriptedAdapter(trace, []);
    const relay = createRelay({ journal, controller, adapter });

    await relay.runOnce(AbortSignal.timeout(1_000)).catch(() => undefined);

    assert.equal(journal.outbox.has(acceptedReport.id), true);
    assert.deepEqual(journal.confirmed, []);
    assert.equal(controller.reports.length, 1);

    await relay.runOnce(AbortSignal.timeout(1_000));

    assert.equal(controller.reports.length, 2);
    assert.deepEqual(controller.reports[1], controller.reports[0]);
    assert.equal(controller.reports[1]?.report_id, acceptedReport.id);
    assert.deepEqual(journal.confirmed, [acceptedReport.id]);
    assert.equal(journal.outbox.has(acceptedReport.id), false);
  });
});
