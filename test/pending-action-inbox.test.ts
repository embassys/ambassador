import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { currentCredential } from "./support/current-credential.js";

const NOW_SECONDS = 1_788_220_800;
const FIRST_CALL_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_CALL_ID = "10000000-0000-4000-8000-000000000002";

function credential(email = "inbox@fixture.test") {
  return parseCentralCredential(currentCredential(email, `agent.${email}`), () => NOW_SECONDS);
}

function actionMessage(callId = FIRST_CALL_ID, marker = "private-action-payload"): CentralMessage {
  return {
    id: `message.${callId.slice(-1)}`,
    sender_agent_id: "agent.requester",
    action_type_id: "action.get_phone_number",
    payload: {
      type: "action_call",
      call_id: callId,
      action_type: "get_phone_number",
      payload: { reason: marker },
    },
    created_at: "2026-09-03T20:00:00Z",
  };
}

test("encrypts unanswered action calls and removes them only after completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-pending-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pending-actions.sqlite");
  const ownerCredential = credential();
  const first = new PendingActionInbox(path, ownerCredential);

  assert.equal(
    first.capture({
      sender_agent_id: "agent.requester",
      payload: { type: "permission_request" },
      created_at: "2026-09-03T19:00:00Z",
    }),
    false,
  );
  assert.equal(first.capture(actionMessage()), true);
  assert.equal(first.capture(actionMessage()), false);
  assert.deepEqual(first.list(), [
    {
      call_id: FIRST_CALL_ID,
      sender_agent_id: "agent.requester",
      action_type: "get_phone_number",
      payload: { reason: "private-action-payload" },
      created_at: "2026-09-03T20:00:00Z",
    },
  ]);
  first.close();

  const bytes = await readFile(path);
  assert.equal(bytes.includes(Buffer.from("private-action-payload", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(FIRST_CALL_ID, "utf8")), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o7777, 0o700);
    assert.equal((await stat(path)).mode & 0o7777, 0o600);
  }

  const restarted = new PendingActionInbox(path, ownerCredential);
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.remove(FIRST_CALL_ID), true);
  assert.equal(restarted.remove(FIRST_CALL_ID), false);
  assert.deepEqual(restarted.list(), []);
  restarted.close();
});

test("orders calls, rejects conflicts, and fails closed with another identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-pending-actions-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pending-actions.sqlite");
  const inbox = new PendingActionInbox(path, credential());
  const later = actionMessage(FIRST_CALL_ID, "later");
  const earlier = {
    ...actionMessage(SECOND_CALL_ID, "earlier"),
    created_at: "2026-09-03T18:00:00Z",
  };
  inbox.capture(later);
  inbox.capture(earlier);
  assert.deepEqual(
    inbox.list().map(({ call_id }) => call_id),
    [SECOND_CALL_ID, FIRST_CALL_ID],
  );
  assert.throws(() => inbox.capture(actionMessage(FIRST_CALL_ID, "conflicting")));
  inbox.close();

  assert.throws(
    () => new PendingActionInbox(path, credential("different@fixture.test")),
    /invalid/u,
  );

  const database = new Database(path);
  database.prepare("UPDATE records SET ciphertext = zeroblob(length(ciphertext))").run();
  database.close();
  assert.throws(() => new PendingActionInbox(path, credential()), /invalid/u);
});

test("rejects malformed action calls and linked inbox artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-pending-actions-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pending-actions.sqlite");
  const inbox = new PendingActionInbox(path, credential());
  assert.throws(() =>
    inbox.capture({
      sender_agent_id: "agent.requester",
      payload: { type: "action_call", call_id: "not-a-call-id" },
      created_at: "2026-09-03T20:00:00Z",
    }),
  );
  assert.throws(() =>
    inbox.capture({
      ...actionMessage(),
      payload: {
        ...actionMessage().payload,
        payload: { token: "must-not-persist" },
      },
    }),
  );
  inbox.close();

  if (process.platform === "win32") return;
  const linkedRoot = join(root, "linked");
  await mkdir(linkedRoot, { mode: 0o700 });
  const target = join(root, "target.sqlite");
  await writeFile(target, "target-data", { mode: 0o600 });
  const symlinkPath = join(linkedRoot, "symlink.sqlite");
  await symlink(target, symlinkPath);
  assert.throws(() => new PendingActionInbox(symlinkPath, credential()));
  assert.equal(await readFile(target, "utf8"), "target-data");

  const hardlinkPath = join(linkedRoot, "hardlink.sqlite");
  await link(target, hardlinkPath);
  assert.throws(() => new PendingActionInbox(hardlinkPath, credential()));
  assert.equal(await readFile(target, "utf8"), "target-data");
});

test("bounds pending action bytes independently from record count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-pending-actions-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const countBounded = new PendingActionInbox(join(root, "count.sqlite"), credential());
  for (let index = 0; index < 256; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    assert.equal(
      countBounded.capture(actionMessage(`20000000-0000-4000-8000-${suffix}`, "bounded")),
      true,
    );
  }
  assert.equal(countBounded.capture(actionMessage("30000000-0000-4000-8000-000000000000")), true);
  countBounded.close();

  const sizeBounded = new PendingActionInbox(join(root, "size.sqlite"), credential(), {
    maximumBytes: 32 * 1024,
  });
  assert.throws(() => sizeBounded.capture(actionMessage(FIRST_CALL_ID, "x".repeat(33 * 1024))));
  sizeBounded.close();
});
