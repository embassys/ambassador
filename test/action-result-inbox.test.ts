import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ActionResultInbox } from "../src/action-result-inbox.js";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { currentCredential } from "./support/current-credential.js";

const NOW_SECONDS = 1_788_220_800;
const FIRST_CALL_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_CALL_ID = "10000000-0000-4000-8000-000000000002";

function credential(email = "result-inbox@fixture.test") {
  return parseCentralCredential(currentCredential(email, `agent.${email}`), () => NOW_SECONDS);
}

function resultMessage(callId = FIRST_CALL_ID, phone = "+447700900001"): CentralMessage {
  return {
    id: `message.${callId.slice(-1)}`,
    sender_agent_id: "agent.target",
    action_type_id: "action.get_phone_number",
    payload: {
      type: "action_response",
      call_id: callId,
      action_type: "get_phone_number",
      status: "success",
      result: { phone_number: phone },
    },
    created_at: "2026-09-04T16:17:55Z",
  };
}

test("encrypts received action results and keeps them across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-action-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "action-results.sqlite");
  const ownerCredential = credential();
  const first = new ActionResultInbox(path, ownerCredential);

  assert.equal(
    first.capture({
      sender_agent_id: "agent.target",
      payload: { type: "permission_outcome" },
      created_at: "2026-09-04T16:00:00Z",
    }),
    false,
  );
  assert.equal(first.capture(resultMessage()), true);
  assert.equal(first.capture(resultMessage()), false);
  assert.deepEqual(first.list(), [
    {
      call_id: FIRST_CALL_ID,
      sender_agent_id: "agent.target",
      action_type: "get_phone_number",
      status: "success",
      result: { phone_number: "+447700900001" },
      created_at: "2026-09-04T16:17:55Z",
    },
  ]);
  first.close();

  const bytes = await readFile(path);
  assert.equal(bytes.includes(Buffer.from("+447700900001", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(FIRST_CALL_ID, "utf8")), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o7777, 0o700);
    assert.equal((await stat(path)).mode & 0o7777, 0o600);
  }

  const restarted = new ActionResultInbox(path, ownerCredential);
  assert.deepEqual(restarted.list(), firstResult());
  assert.equal(restarted.removeMany(firstResult().map((value) => value.call_id)), 1);
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.removeMany([]), 0);
  restarted.close();

  const consumedRestart = new ActionResultInbox(path, ownerCredential);
  assert.deepEqual(consumedRestart.list(), []);
  consumedRestart.close();
});

function firstResult() {
  return [
    {
      call_id: FIRST_CALL_ID,
      sender_agent_id: "agent.target",
      action_type: "get_phone_number",
      status: "success" as const,
      result: { phone_number: "+447700900001" },
      created_at: "2026-09-04T16:17:55Z",
    },
  ];
}

test("orders results, accepts error results, rejects conflicts, and binds the identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-action-results-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "action-results.sqlite");
  const inbox = new ActionResultInbox(path, credential());
  const later = resultMessage(FIRST_CALL_ID);
  const earlier: CentralMessage = {
    ...resultMessage(SECOND_CALL_ID),
    payload: {
      type: "action_response",
      call_id: SECOND_CALL_ID,
      action_type: "get_phone_number",
      status: "error",
      result: { message: "not available" },
    },
    created_at: "2026-09-04T16:00:00Z",
  };
  inbox.capture(later);
  inbox.capture(earlier);
  assert.deepEqual(
    inbox.list().map(({ call_id, status }) => ({ call_id, status })),
    [
      { call_id: SECOND_CALL_ID, status: "error" },
      { call_id: FIRST_CALL_ID, status: "success" },
    ],
  );
  assert.throws(() => inbox.capture(resultMessage(FIRST_CALL_ID, "+447700900002")));
  inbox.close();

  assert.throws(
    () => new ActionResultInbox(path, credential("different@fixture.test")),
    /invalid/u,
  );

  const database = new Database(path);
  database.prepare("UPDATE records SET ciphertext = zeroblob(length(ciphertext))").run();
  database.close();
  assert.throws(() => new ActionResultInbox(path, credential()), /invalid/u);
});

test("rejects malformed responses, credential fields, and linked inbox artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-action-results-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "action-results.sqlite");
  const inbox = new ActionResultInbox(path, credential());
  assert.throws(() =>
    inbox.capture({
      sender_agent_id: "agent.target",
      payload: { type: "action_response", call_id: "not-a-call-id" },
      created_at: "2026-09-04T16:17:55Z",
    }),
  );
  assert.throws(() =>
    inbox.capture({
      ...resultMessage(),
      payload: {
        ...resultMessage().payload,
        result: { token: "must-not-persist" },
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
  assert.throws(() => new ActionResultInbox(symlinkPath, credential()));
  assert.equal(await readFile(target, "utf8"), "target-data");

  const hardlinkPath = join(linkedRoot, "hardlink.sqlite");
  await link(target, hardlinkPath);
  assert.throws(() => new ActionResultInbox(hardlinkPath, credential()));
  assert.equal(await readFile(target, "utf8"), "target-data");
});

test("bounds received result bytes independently from record count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-action-results-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const countBounded = new ActionResultInbox(join(root, "count.sqlite"), credential());
  for (let index = 0; index < 256; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    assert.equal(countBounded.capture(resultMessage(`20000000-0000-4000-8000-${suffix}`)), true);
  }
  assert.equal(countBounded.capture(resultMessage("30000000-0000-4000-8000-000000000000")), true);
  countBounded.close();

  const sizeBounded = new ActionResultInbox(join(root, "size.sqlite"), credential(), {
    maximumBytes: 32 * 1024,
  });
  assert.throws(() => sizeBounded.capture(resultMessage(FIRST_CALL_ID, "x".repeat(33 * 1024))));
  sizeBounded.close();
});
