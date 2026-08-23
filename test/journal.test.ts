import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Journal, type OutboxRecord } from "../src/journal.js";
import type { Notification, PollResponse } from "../src/protocol.js";

const ISSUED_AT = "2026-08-23T11:59:00Z";
const SERVER_TIME = "2026-08-23T12:00:00Z";
const EXPIRES_AT = "2026-08-23T12:10:00Z";
const NOW_MS = Date.parse(SERVER_TIME);

type AckRecord = Extract<OutboxRecord, { kind: "ack" }>;
type ReportRecord = Extract<OutboxRecord, { kind: "report" }>;

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: "notification-1",
    delivery_id: "delivery-1",
    binding_id: "binding-1",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

function poll(cursor: string, notifications: Notification[]): PollResponse {
  return {
    protocol_version: 1,
    cursor,
    server_time: SERVER_TIME,
    notifications,
  };
}

function ackRecords(journal: Journal): AckRecord[] {
  return journal.listOutbox(100).filter((record): record is AckRecord => record.kind === "ack");
}

function reportRecords(journal: Journal, deliveryId?: string): ReportRecord[] {
  return journal
    .listOutbox(100)
    .filter(
      (record): record is ReportRecord =>
        record.kind === "report" && (deliveryId === undefined || record.deliveryId === deliveryId),
    );
}

function temporaryJournal(t: TestContext): {
  open: () => Journal;
  close: (journal: Journal) => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "a2a-journal-test-"));
  const path = join(directory, "journal.sqlite");
  const openJournals = new Set<Journal>();
  let nextId = 0;

  t.after(() => {
    for (const journal of openJournals) {
      journal.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    open: () => {
      const journal = new Journal(path, () => `outbox-${++nextId}`);
      openJournals.add(journal);
      return journal;
    },
    close: (journal) => {
      if (openJournals.delete(journal)) {
        journal.close();
      }
    },
  };
}

test("commits a poll batch and cursor atomically and persists an empty cursor advance", (t) => {
  const fixture = temporaryJournal(t);
  let journal = fixture.open();
  const first = notification();
  const second = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
  });

  assert.deepEqual(journal.ingestPoll(poll("cursor-1", [first, second]), 10, NOW_MS), {
    inserted: 2,
    duplicates: 0,
  });
  assert.equal(journal.getCursor(), "cursor-1");
  assert.equal(journal.activeCount(), 2);

  const stored = journal.getDelivery("delivery-1");
  assert.ok(stored);
  assert.equal(stored.notificationId, first.notification_id);
  assert.equal(stored.bindingId, first.binding_id);
  assert.equal(stored.issuedAtMs, Date.parse(first.issued_at));
  assert.equal(stored.expiresAtMs, Date.parse(first.expires_at));
  assert.equal(stored.state, "pending");
  assert.equal(stored.attemptCount, 0);
  assert.equal(stored.mayHaveReachedRuntime, false);
  assert.equal(stored.reportSequence, 0);

  const acknowledgements = ackRecords(journal);
  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(
    acknowledgements.map(({ notificationId, deliveryId, persistedAt }) => ({
      notificationId,
      deliveryId,
      persistedAt,
    })),
    [
      {
        notificationId: "notification-1",
        deliveryId: "delivery-1",
        persistedAt: new Date(NOW_MS).toISOString(),
      },
      {
        notificationId: "notification-2",
        deliveryId: "delivery-2",
        persistedAt: new Date(NOW_MS).toISOString(),
      },
    ],
  );

  fixture.close(journal);
  journal = fixture.open();
  assert.equal(journal.getCursor(), "cursor-1");
  assert.equal(journal.getDelivery("delivery-2")?.state, "pending");

  assert.deepEqual(journal.ingestPoll(poll("cursor-2", []), 10, NOW_MS + 1_000), {
    inserted: 0,
    duplicates: 0,
  });
  assert.equal(journal.getCursor(), "cursor-2");
  assert.equal(ackRecords(journal).length, 2);
});

test("coalesces exact duplicates and keeps one stable acknowledgement", (t) => {
  const journal = temporaryJournal(t).open();
  const notice = notification();

  assert.deepEqual(journal.ingestPoll(poll("cursor-1", [notice, { ...notice }]), 10, NOW_MS), {
    inserted: 1,
    duplicates: 1,
  });
  const originalAcknowledgements = ackRecords(journal);
  assert.equal(originalAcknowledgements.length, 1);

  assert.deepEqual(journal.ingestPoll(poll("cursor-2", [{ ...notice }]), 10, NOW_MS + 60_000), {
    inserted: 0,
    duplicates: 1,
  });
  assert.equal(journal.getCursor(), "cursor-2");
  assert.equal(journal.activeCount(), 1);
  assert.deepEqual(ackRecords(journal), originalAcknowledgements);
  assert.equal(originalAcknowledgements[0]?.persistedAt, new Date(NOW_MS).toISOString());
});

test("rejects a notification ID conflict without committing earlier rows or the cursor", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-before", [notification()]), 10, NOW_MS);
  const originalOutbox = journal.listOutbox(100);

  const fresh = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
  });
  const conflicting = notification({ binding_id: "binding-changed" });

  assert.throws(() =>
    journal.ingestPoll(poll("cursor-conflict", [fresh, conflicting]), 10, NOW_MS + 1_000),
  );
  assert.equal(journal.getCursor(), "cursor-before");
  assert.equal(journal.getDelivery("delivery-2"), undefined);
  assert.equal(journal.getDelivery("delivery-1")?.bindingId, "binding-1");
  assert.deepEqual(journal.listOutbox(100), originalOutbox);
});

test("rejects reuse of a delivery ID without committing any of the poll batch", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-before", [notification()]), 10, NOW_MS);
  const originalOutbox = journal.listOutbox(100);

  const fresh = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
  });
  const reusedDelivery = notification({
    notification_id: "notification-3",
    delivery_id: "delivery-1",
  });

  assert.throws(() =>
    journal.ingestPoll(poll("cursor-conflict", [fresh, reusedDelivery]), 10, NOW_MS + 1_000),
  );
  assert.equal(journal.getCursor(), "cursor-before");
  assert.equal(journal.getDelivery("delivery-2"), undefined);
  assert.equal(journal.getDelivery("delivery-1")?.notificationId, "notification-1");
  assert.deepEqual(journal.listOutbox(100), originalOutbox);
});

test("rejects an over-capacity batch all-or-none and leaves the journal usable", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-before", [notification()]), 2, NOW_MS);
  const originalOutbox = journal.listOutbox(100);
  const second = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
  });
  const third = notification({
    notification_id: "notification-3",
    delivery_id: "delivery-3",
  });

  assert.throws(() =>
    journal.ingestPoll(poll("cursor-too-far", [second, third]), 2, NOW_MS + 1_000),
  );
  assert.equal(journal.getCursor(), "cursor-before");
  assert.equal(journal.activeCount(), 1);
  assert.equal(journal.getDelivery("delivery-2"), undefined);
  assert.equal(journal.getDelivery("delivery-3"), undefined);
  assert.deepEqual(journal.listOutbox(100), originalOutbox);

  assert.deepEqual(
    journal.ingestPoll(poll("cursor-after", [notification(), second]), 2, NOW_MS + 2_000),
    { inserted: 1, duplicates: 1 },
  );
  assert.equal(journal.getCursor(), "cursor-after");
  assert.equal(journal.activeCount(), 2);
});

test("claims a due delivery atomically across journal connections", (t) => {
  const fixture = temporaryJournal(t);
  const firstConnection = fixture.open();
  const secondConnection = fixture.open();
  firstConnection.ingestPoll(poll("cursor-1", [notification()]), 10, NOW_MS);

  assert.deepEqual(
    firstConnection.listDue(NOW_MS, 10).map(({ deliveryId }) => deliveryId),
    ["delivery-1"],
  );
  assert.deepEqual(
    secondConnection.listDue(NOW_MS, 10).map(({ deliveryId }) => deliveryId),
    ["delivery-1"],
  );

  const firstClaim = firstConnection.claimDelivery("delivery-1", "fingerprint-1", NOW_MS);
  const competingClaim = secondConnection.claimDelivery("delivery-1", "fingerprint-1", NOW_MS);

  assert.equal(firstClaim.status, "claimed");
  assert.ok(firstClaim.delivery);
  assert.equal(firstClaim.delivery.state, "waking");
  assert.equal(firstClaim.delivery.attemptCount, 1);
  assert.equal(firstClaim.delivery.bindingFingerprint, "fingerprint-1");
  assert.equal(competingClaim.status, "not_due");
  assert.equal(firstConnection.getDelivery("delivery-1")?.attemptCount, 1);
  assert.deepEqual(secondConnection.listDue(NOW_MS, 10), []);
});

test("allows only one active claim and enforces the retry schedule", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-1", [notification()]), 10, NOW_MS);

  assert.equal(journal.claimDelivery("delivery-1", "fingerprint-1", NOW_MS).status, "claimed");
  assert.equal(journal.claimDelivery("delivery-1", "fingerprint-1", NOW_MS).status, "not_due");

  const retryAtMs = NOW_MS + 5_000;
  journal.recordWakeResult(
    "delivery-1",
    {
      status: "retrying",
      reason: "runtime_unavailable",
      nextAttemptAtMs: retryAtMs,
      mayHaveReachedRuntime: false,
    },
    NOW_MS + 100,
  );

  assert.equal(
    journal.claimDelivery("delivery-1", "fingerprint-1", retryAtMs - 1).status,
    "not_due",
  );
  assert.equal(journal.claimDelivery("delivery-1", "fingerprint-1", retryAtMs).status, "claimed");
  assert.equal(journal.getDelivery("delivery-1")?.attemptCount, 2);
});

test("writes stable monotonic wake reports and preserves a stale report confirmed out of order", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-1", [notification()]), 10, NOW_MS);
  journal.claimDelivery("delivery-1", "fingerprint-1", NOW_MS);

  const retryAtMs = NOW_MS + 5_000;
  const firstObservedAtMs = NOW_MS + 100;
  journal.recordWakeResult(
    "delivery-1",
    {
      status: "retrying",
      reason: "outcome_unknown",
      nextAttemptAtMs: retryAtMs,
      mayHaveReachedRuntime: true,
    },
    firstObservedAtMs,
  );

  const firstReport = reportRecords(journal, "delivery-1")[0];
  assert.ok(firstReport);
  assert.equal(firstReport.sequence, 1);
  assert.equal(firstReport.status, "retrying");
  assert.equal(firstReport.reason, "outcome_unknown");
  assert.equal(firstReport.observedAt, new Date(firstObservedAtMs).toISOString());
  assert.equal(firstReport.nextAttemptAt, new Date(retryAtMs).toISOString());
  assert.equal(journal.getDelivery("delivery-1")?.reportSequence, 1);

  assert.equal(journal.claimDelivery("delivery-1", "fingerprint-1", retryAtMs).status, "claimed");
  const acceptedAtMs = retryAtMs + 100;
  journal.recordWakeResult(
    "delivery-1",
    { status: "accepted", sessionId: "local-session-1" },
    acceptedAtMs,
  );

  const reports = reportRecords(journal, "delivery-1");
  assert.deepEqual(
    reports.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.deepEqual(
    journal
      .listOutbox(100)
      .map((record) => (record.kind === "ack" ? "ack" : `report-${record.sequence}`)),
    ["ack", "report-1", "report-2"],
  );
  assert.deepEqual(reports[0], firstReport);
  assert.equal(reports[1]?.status, "accepted");
  assert.equal(reports[1]?.reason, undefined);
  assert.equal(reports[1]?.nextAttemptAt, undefined);
  assert.equal(reports[1]?.observedAt, new Date(acceptedAtMs).toISOString());

  const stored = journal.getDelivery("delivery-1");
  assert.equal(stored?.state, "accepted");
  assert.equal(stored?.runtimeSessionId, "local-session-1");
  assert.equal(stored?.reportSequence, 2);
  assert.equal(stored?.mayHaveReachedRuntime, true);

  const newerReport = reports[1];
  assert.ok(newerReport);
  journal.confirmOutbox(newerReport.id, acceptedAtMs + 1);
  assert.deepEqual(reportRecords(journal, "delivery-1"), [firstReport]);
  const staleOutbox = journal.listOutbox(100);
  assert.deepEqual(
    staleOutbox.map((record) => (record.kind === "ack" ? "ack" : `report-${record.sequence}`)),
    ["ack", "report-1"],
  );
  assert.deepEqual(journal.listOutbox(100), staleOutbox);

  journal.confirmOutbox(firstReport.id, acceptedAtMs + 2);
  assert.deepEqual(reportRecords(journal, "delivery-1"), []);
});

test("recovers a persisted waking delivery as an unknown-outcome retry", (t) => {
  const fixture = temporaryJournal(t);
  let journal = fixture.open();
  const pending = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
  });
  journal.ingestPoll(poll("cursor-1", [notification(), pending]), 10, NOW_MS);
  journal.claimDelivery("delivery-1", "fingerprint-1", NOW_MS);

  fixture.close(journal);
  journal = fixture.open();
  const recoveredAtMs = NOW_MS + 1_000;
  assert.equal(journal.recoverInFlight(recoveredAtMs), 1);

  const recovered = journal.getDelivery("delivery-1");
  assert.equal(recovered?.state, "retry_wait");
  assert.equal(recovered?.attemptCount, 1);
  assert.equal(recovered?.nextAttemptAtMs, recoveredAtMs);
  assert.equal(recovered?.mayHaveReachedRuntime, true);
  assert.equal(recovered?.reportSequence, 1);
  assert.equal(journal.getDelivery("delivery-2")?.state, "pending");

  const recoveryReports = reportRecords(journal, "delivery-1");
  assert.equal(recoveryReports.length, 1);
  assert.equal(recoveryReports[0]?.sequence, 1);
  assert.equal(recoveryReports[0]?.status, "retrying");
  assert.equal(recoveryReports[0]?.reason, "outcome_unknown");
  assert.equal(recoveryReports[0]?.observedAt, new Date(recoveredAtMs).toISOString());
  assert.equal(recoveryReports[0]?.nextAttemptAt, new Date(recoveredAtMs).toISOString());

  assert.equal(journal.recoverInFlight(recoveredAtMs + 1), 0);
  assert.deepEqual(reportRecords(journal, "delivery-1"), recoveryReports);
});

test("expires deliveries based on whether any attempt may have reached the runtime", (t) => {
  const journal = temporaryJournal(t).open();
  const expiresAt = "2026-08-23T12:01:00Z";
  const expiresAtMs = Date.parse(expiresAt);
  const neverAttempted = notification({ expires_at: expiresAt });
  const knownNotReached = notification({
    notification_id: "notification-2",
    delivery_id: "delivery-2",
    expires_at: expiresAt,
  });
  const mayHaveReached = notification({
    notification_id: "notification-3",
    delivery_id: "delivery-3",
    expires_at: expiresAt,
  });
  journal.ingestPoll(
    poll("cursor-1", [neverAttempted, knownNotReached, mayHaveReached]),
    10,
    NOW_MS,
  );

  journal.claimDelivery("delivery-2", "fingerprint-2", NOW_MS);
  journal.recordWakeResult(
    "delivery-2",
    {
      status: "retrying",
      reason: "runtime_unavailable",
      nextAttemptAtMs: expiresAtMs + 5_000,
      mayHaveReachedRuntime: false,
    },
    NOW_MS + 100,
  );
  journal.claimDelivery("delivery-3", "fingerprint-3", NOW_MS);
  journal.recordWakeResult(
    "delivery-3",
    {
      status: "retrying",
      reason: "outcome_unknown",
      nextAttemptAtMs: expiresAtMs + 5_000,
      mayHaveReachedRuntime: true,
    },
    NOW_MS + 200,
  );

  assert.equal(journal.expireDue(expiresAtMs), 3);
  assert.equal(journal.getDelivery("delivery-1")?.state, "expired");
  assert.equal(journal.getDelivery("delivery-2")?.state, "expired");
  assert.equal(journal.getDelivery("delivery-3")?.state, "uncertain");
  assert.equal(journal.activeCount(), 0);

  const neverAttemptedReports = reportRecords(journal, "delivery-1");
  assert.equal(neverAttemptedReports.length, 1);
  assert.equal(neverAttemptedReports[0]?.sequence, 1);
  assert.equal(neverAttemptedReports[0]?.status, "expired");
  assert.equal(neverAttemptedReports[0]?.reason, undefined);

  const knownNotReachedReports = reportRecords(journal, "delivery-2");
  assert.deepEqual(
    knownNotReachedReports.map(({ sequence, status }) => ({ sequence, status })),
    [
      { sequence: 1, status: "retrying" },
      { sequence: 2, status: "expired" },
    ],
  );
  assert.equal(knownNotReachedReports[1]?.reason, undefined);

  const mayHaveReachedReports = reportRecords(journal, "delivery-3");
  assert.deepEqual(
    mayHaveReachedReports.map(({ sequence, status }) => ({ sequence, status })),
    [
      { sequence: 1, status: "retrying" },
      { sequence: 2, status: "uncertain" },
    ],
  );
  assert.equal(mayHaveReachedReports[1]?.reason, "expired_after_attempt");
});

test("reports binding_changed instead of waking a different pinned binding after uncertainty", (t) => {
  const journal = temporaryJournal(t).open();
  journal.ingestPoll(poll("cursor-1", [notification()]), 10, NOW_MS);
  journal.claimDelivery("delivery-1", "fingerprint-original", NOW_MS);
  const retryAtMs = NOW_MS + 1_000;
  journal.recordWakeResult(
    "delivery-1",
    {
      status: "retrying",
      reason: "outcome_unknown",
      nextAttemptAtMs: retryAtMs,
      mayHaveReachedRuntime: true,
    },
    NOW_MS + 100,
  );

  const changedClaim = journal.claimDelivery("delivery-1", "fingerprint-reconfigured", retryAtMs);
  assert.equal(changedClaim.status, "binding_changed");

  const stored = journal.getDelivery("delivery-1");
  assert.equal(stored?.state, "uncertain");
  assert.equal(stored?.attemptCount, 1);
  assert.equal(stored?.bindingFingerprint, "fingerprint-original");
  assert.equal(stored?.reportSequence, 2);

  const reports = reportRecords(journal, "delivery-1");
  assert.deepEqual(
    reports.map(({ sequence, status, reason }) => ({ sequence, status, reason })),
    [
      { sequence: 1, status: "retrying", reason: "outcome_unknown" },
      { sequence: 2, status: "uncertain", reason: "binding_changed" },
    ],
  );
  assert.equal(
    journal.claimDelivery("delivery-1", "fingerprint-reconfigured", retryAtMs).status,
    "not_due",
  );
  assert.equal(reportRecords(journal, "delivery-1").length, 2);
});

test("hides confirmed outbox rows without recreating them or deleting delivery state", (t) => {
  const journal = temporaryJournal(t).open();
  const notice = notification();
  journal.ingestPoll(poll("cursor-1", [notice]), 10, NOW_MS);

  const acknowledgement = ackRecords(journal)[0];
  assert.ok(acknowledgement);
  journal.confirmOutbox(acknowledgement.id, NOW_MS + 1);
  assert.deepEqual(journal.listOutbox(100), []);

  assert.deepEqual(journal.ingestPoll(poll("cursor-2", [{ ...notice }]), 10, NOW_MS + 1_000), {
    inserted: 0,
    duplicates: 1,
  });
  assert.deepEqual(journal.listOutbox(100), []);
  assert.equal(journal.getCursor(), "cursor-2");

  journal.claimDelivery("delivery-1", "fingerprint-1", NOW_MS + 1_000);
  journal.recordWakeResult(
    "delivery-1",
    { status: "accepted", sessionId: "local-session-1" },
    NOW_MS + 1_100,
  );
  const report = reportRecords(journal, "delivery-1")[0];
  assert.ok(report);
  journal.confirmOutbox(report.id, NOW_MS + 1_200);
  assert.deepEqual(journal.listOutbox(100), []);

  assert.doesNotThrow(() => journal.confirmOutbox(acknowledgement.id, NOW_MS + 1_300));
  assert.doesNotThrow(() => journal.confirmOutbox(report.id, NOW_MS + 1_300));
  assert.equal(journal.getDelivery("delivery-1")?.state, "accepted");
  assert.equal(journal.getDelivery("delivery-1")?.runtimeSessionId, "local-session-1");
});
