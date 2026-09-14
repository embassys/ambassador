import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";

import { NotificationJournal } from "../../src/notification-journal.js";

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

import { assertPrivateArtifact } from "../support/private-artifact.js";

test("enforces native private permissions on the journal and its state directory", async (t) => {
  const item = fixture(t);
  const journal = item.open();
  journal.ingest(["message-1"]);

  await assertPrivateArtifact(dirname(item.path), "directory");
  await assertPrivateArtifact(item.path, "file");
});
