import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import { NotificationJournal } from "../src/notification-journal.js";

const NOW_MS = Date.parse("2026-08-25T12:00:00Z");

function journalFixture(t: TestContext): {
  path: string;
  open: () => NotificationJournal;
  close: (journal: NotificationJournal) => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "a2a-notification-journal-test-"));
  const path = join(directory, "notifications.sqlite");
  const openJournals = new Set<NotificationJournal>();

  t.after(() => {
    for (const journal of openJournals) journal.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    path,
    open: () => {
      const journal = new NotificationJournal(path);
      openJournals.add(journal);
      return journal;
    },
    close: (journal) => {
      if (openJournals.delete(journal)) journal.close();
    },
  };
}

test("creates a strict ID-only schema", (t) => {
  const fixture = journalFixture(t);
  const journal = fixture.open();
  journal.ingest(["message-1"], NOW_MS);
  fixture.close(journal);

  const database = new Database(fixture.path, { readonly: true });
  t.after(() => database.close());
  const table = database
    .prepare<[string], { name: string; strict: number }>(
      "SELECT name, strict FROM pragma_table_list WHERE name = ?",
    )
    .get("notification_relay");
  assert.deepEqual(table, { name: "notification_relay", strict: 1 });

  const columns = database
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notification_relay')")
    .all()
    .map(({ name }) => name);
  assert.deepEqual(columns, [
    "message_id",
    "notification_ack_state",
    "notification_ack_attempt_count",
    "notification_ack_next_attempt_at_ms",
    "wake_state",
    "wake_attempt_count",
    "wake_next_attempt_at_ms",
    "wake_may_have_reached",
  ]);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
});

test("validates complete batches and coalesces exact URI-unreserved IDs", (t) => {
  const journal = journalFixture(t).open();
  const longestId = "a".repeat(128);

  assert.deepEqual(journal.ingest(["AZaz09-._~", longestId, "AZaz09-._~"], NOW_MS), {
    inserted: 2,
    duplicates: 1,
  });
  assert.deepEqual(journal.ingest(["AZaz09-._~"], NOW_MS + 1), {
    inserted: 0,
    duplicates: 1,
  });

  for (const invalid of ["", "a".repeat(129), "slash/id", "space id", "caf\u00e9", "line\nfeed"]) {
    assert.throws(() => journal.ingest(["must-not-commit", invalid], NOW_MS + 2));
    assert.equal(journal.get("must-not-commit"), undefined);
  }
});

test("claims notification acknowledgement and wake independently before each attempt", (t) => {
  const journal = journalFixture(t).open();
  journal.ingest(["message-1"], NOW_MS);

  assert.deepEqual(journal.claimDueNotificationAcknowledgement(NOW_MS), {
    messageId: "message-1",
    attemptCount: 1,
  });
  assert.equal(journal.claimDueNotificationAcknowledgement(NOW_MS), undefined);

  assert.deepEqual(journal.claimDueWake(NOW_MS), {
    messageId: "message-1",
    attemptCount: 1,
    mayHaveReachedWebhook: false,
  });
  assert.equal(journal.claimDueWake(NOW_MS), undefined);

  journal.recordNotificationAcknowledgementSuccess("message-1");
  journal.recordWakeAccepted("message-1", NOW_MS + 60_000);
  assert.deepEqual(journal.get("message-1"), {
    messageId: "message-1",
    notificationAcknowledgementState: "confirmed",
    notificationAcknowledgementAttemptCount: 1,
    wakeState: "accepted_wait",
    wakeAttemptCount: 1,
    wakeNextAttemptAtMs: NOW_MS + 60_000,
    wakeMayHaveReachedWebhook: true,
  });

  assert.equal(journal.claimDueWake(NOW_MS + 59_999), undefined);
  assert.equal(journal.claimDueWake(NOW_MS + 60_000)?.attemptCount, 2);
  assert.equal(journal.confirmContentAcknowledgement("message-1"), true);
  journal.recordWakeRetry("message-1", NOW_MS + 61_000, true);
  assert.equal(journal.get("message-1")?.wakeState, "content_acknowledged");
  assert.equal(journal.nextWakeAtMs(), null);
  assert.equal(journal.confirmContentAcknowledgement("unknown-id"), false);
});

test("recovers in-flight work after restart without resetting attempts", (t) => {
  const fixture = journalFixture(t);
  let journal = fixture.open();
  journal.ingest(["message-1"], NOW_MS);
  journal.claimDueNotificationAcknowledgement(NOW_MS);
  journal.claimDueWake(NOW_MS);
  fixture.close(journal);

  journal = fixture.open();
  const recoveredAttempts: number[] = [];
  assert.deepEqual(
    journal.recoverInFlight(NOW_MS + 100, (attemptCount) => {
      recoveredAttempts.push(attemptCount);
      return NOW_MS + 600;
    }),
    { notificationAcknowledgements: 1, wakes: 1 },
  );
  assert.deepEqual(recoveredAttempts, [1]);
  assert.equal(journal.nextNotificationAcknowledgementAtMs(), NOW_MS + 100);
  assert.equal(journal.nextWakeAtMs(), NOW_MS + 600);
  assert.equal(journal.claimDueWake(NOW_MS + 599), undefined);
  assert.deepEqual(journal.claimDueWake(NOW_MS + 600), {
    messageId: "message-1",
    attemptCount: 2,
    mayHaveReachedWebhook: true,
  });

  assert.deepEqual(journal.ingest(["message-1"], NOW_MS + 700), {
    inserted: 0,
    duplicates: 1,
  });
  assert.equal(journal.get("message-1")?.wakeAttemptCount, 2);
});

test("discards nonterminal IDs when their consuming REST bodies cannot be recovered", (t) => {
  const journal = journalFixture(t).open();
  journal.ingest(["pending-message", "acked-message"], NOW_MS);
  assert.equal(journal.confirmContentAcknowledgement("acked-message"), true);

  assert.equal(journal.discardUnrecoverable(), 1);
  assert.equal(journal.get("pending-message"), undefined);
  assert.equal(journal.get("acked-message")?.wakeState, "content_acknowledged");
  assert.equal(journal.discardUnrecoverable(), 0);
});

test("rejects an unrelated version-one schema instead of treating it as relay state", (t) => {
  const fixture = journalFixture(t);
  const database = new Database(fixture.path);
  database.exec("CREATE TABLE unrelated (value TEXT) STRICT");
  database.pragma("user_version = 1");
  database.close();

  assert.throws(() => fixture.open(), /schema/i);
});
