import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";

import Database from "better-sqlite3";

import { NotificationJournal } from "../src/notification-journal.js";
import { assertNativeWindowsAcl } from "./support/windows-acl.js";

function fixture(t: TestContext): { path: string; open(): NotificationJournal } {
  const directory = mkdtempSync(join(tmpdir(), "ambassador-journal-"));
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

test("creates a strict journal containing IDs and delivery state only", (t) => {
  const item = fixture(t);
  const journal = item.open();
  journal.ingest(["message-1"]);
  journal.close();
  const database = new Database(item.path, { readonly: true });
  try {
    const columns = database
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notification_delivery')")
      .all()
      .map(({ name }) => name);
    assert.deepEqual(columns, ["message_id", "delivery_state"]);
    for (const forbidden of ["body", "payload", "token", "secret", "prompt", "output"]) {
      assert.equal(
        columns.some((name) => name.includes(forbidden)),
        false,
      );
    }
  } finally {
    database.close();
  }
});

test("records the delivery and acknowledgement custody boundaries", (t) => {
  const journal = fixture(t).open();
  assert.deepEqual(journal.ingest(["message-1", "message-1", "message-2"]), {
    inserted: 2,
    duplicates: 1,
  });
  journal.beginDelivery("message-1");
  journal.recordDelivered("message-1", "accepted");
  assert.equal(journal.get("message-1")?.deliveryState, "accepted");
  journal.beginAcknowledgement("message-1");
  assert.equal(journal.get("message-1")?.deliveryState, "acknowledging");
  journal.removeAcknowledged("message-1");
  assert.equal(journal.get("message-1"), undefined);
  assert.equal(journal.count(), 1);
});

test("startup discards only bodies that cannot be recovered", (t) => {
  const journal = fixture(t).open();
  journal.ingest(["pending", "delivering", "accepted"]);
  journal.beginDelivery("delivering");
  journal.beginDelivery("accepted");
  journal.recordDelivered("accepted", "completed");
  assert.equal(journal.discardUndelivered(), 2);
  assert.deepEqual(journal.recoverableAcknowledgements(), [
    { messageId: "accepted", deliveryState: "completed" },
  ]);
});

test("rejects obsolete or unrelated schemas without migration", (t) => {
  const item = fixture(t);
  const database = new Database(item.path);
  database.exec(
    "CREATE TABLE notification_delivery (message_id TEXT PRIMARY KEY, body TEXT) STRICT",
  );
  database.pragma("user_version = 1");
  database.close();
  assert.throws(() => item.open(), /schema/i);
});

test("enforces native Windows DACLs on the journal and its state directory", {
  skip: process.platform !== "win32",
}, async (t) => {
  const item = fixture(t);
  const journal = item.open();
  journal.ingest(["message-1"]);

  await assertNativeWindowsAcl(dirname(item.path), "directory");
  await assertNativeWindowsAcl(item.path, "file");
});
