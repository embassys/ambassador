import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import Database from "better-sqlite3";

import { NotificationJournal } from "../src/notification-journal.js";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function fixture(t: TestContext): { path: string; open(): NotificationJournal } {
  const directory = mkdtempSync(join(tmpdir(), "a2a-journal-current-"));
  const path = join(directory, "notifications.sqlite3");
  const journals = new Set<NotificationJournal>();
  t.after(() => {
    for (const journal of journals) journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const journal = new NotificationJournal(path);
      journals.add(journal);
      return journal;
    },
  };
}

test("creates a strict ID-only current schema", (t) => {
  const item = fixture(t);
  const journal = item.open();
  journal.ingest(["message-1"], NOW);
  journal.close();
  const database = new Database(item.path, { readonly: true });
  try {
    const columns = database
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notification_relay')")
      .all()
      .map(({ name }) => name);
    assert.deepEqual(columns, [
      "message_id",
      "wake_state",
      "wake_attempt_count",
      "wake_next_attempt_at_ms",
      "wake_may_have_reached",
    ]);
    for (const forbidden of ["body", "payload", "token", "lease", "ack_state"]) {
      assert.equal(
        columns.some((name) => name.includes(forbidden)),
        false,
      );
    }
  } finally {
    database.close();
  }
});

test("coalesces IDs and maintains only wake delivery state", (t) => {
  const journal = fixture(t).open();
  assert.deepEqual(journal.ingest(["message-1", "message-1", "message-2"], NOW), {
    inserted: 2,
    duplicates: 1,
  });
  assert.deepEqual(journal.claimDueWake(NOW), {
    messageId: "message-1",
    attemptCount: 1,
    mayHaveReachedWebhook: false,
  });
  journal.recordWakeRetry("message-1", NOW + 1_000, true);
  assert.equal(journal.claimDueWake(NOW)?.messageId, "message-2");
  journal.recordWakeAccepted("message-2", NOW + 60_000);
  assert.equal(journal.remove("message-1"), true);
  assert.equal(journal.remove("message-1"), false);
  assert.equal(journal.count(), 1);
});

test("discardAll records the documented restart-loss boundary", (t) => {
  const journal = fixture(t).open();
  journal.ingest(["consumed-1", "consumed-2"], NOW);
  assert.equal(journal.discardAll(), 2);
  assert.equal(journal.count(), 0);
});

test("rejects obsolete or unrelated schemas without migration", (t) => {
  const item = fixture(t);
  const database = new Database(item.path);
  database.exec("CREATE TABLE notification_relay (message_id TEXT PRIMARY KEY, body TEXT) STRICT");
  database.pragma("user_version = 1");
  database.close();
  assert.throws(() => item.open(), /schema/i);
});
