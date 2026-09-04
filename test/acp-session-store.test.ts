import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { AcpSessionStore } from "../src/acp-session-store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-acp-sessions-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "sessions.sqlite") };
}

test("persists, retires, lists, expires, and forgets bounded ACP session metadata", async (t) => {
  const value = await fixture(t);
  const first = new AcpSessionStore(value.path);
  first.create({
    session_id: "provider-session-1",
    agent_kind: "codex",
    working_directory: value.root,
    central_message_id: "message-1",
    call_id: "call-1",
    status: "active",
    created_at_ms: 1_000,
    last_used_at_ms: 1_000,
  });
  assert.equal(first.findActiveByMessage("message-1")?.session_id, "provider-session-1");
  first.touch("provider-session-1", 2_000);
  assert.equal(first.retireByCallId("call-1", 3_000), true);
  assert.equal(first.retireByCallId("call-1", 4_000), false);
  assert.deepEqual(first.expiredRetired(2_999), []);
  assert.equal(first.expiredRetired(3_000)[0]?.status, "retired");
  first.close();

  const reopened = new AcpSessionStore(value.path);
  assert.deepEqual(reopened.get("provider-session-1"), {
    session_id: "provider-session-1",
    agent_kind: "codex",
    working_directory: value.root,
    central_message_id: "message-1",
    call_id: "call-1",
    status: "retired",
    created_at_ms: 1_000,
    last_used_at_ms: 3_000,
    retired_at_ms: 3_000,
  });
  assert.equal(reopened.forget("provider-session-1"), true);
  assert.equal(reopened.forget("provider-session-1"), false);
  reopened.close();
});

test("rejects duplicate correlations, invalid records, links, and unexpected schemas", async (t) => {
  const value = await fixture(t);
  const store = new AcpSessionStore(value.path);
  store.create({
    session_id: "provider-session-1",
    agent_kind: "claude",
    working_directory: value.root,
    central_message_id: "message-1",
    status: "active",
    created_at_ms: 1,
    last_used_at_ms: 1,
  });
  assert.throws(() =>
    store.create({
      session_id: "provider-session-2",
      agent_kind: "claude",
      working_directory: value.root,
      central_message_id: "message-1",
      status: "active",
      created_at_ms: 1,
      last_used_at_ms: 1,
    }),
  );
  store.close();

  const symlinkPath = join(value.root, "symlink.sqlite");
  await symlink(value.path, symlinkPath);
  assert.throws(() => new AcpSessionStore(symlinkPath));
  const hardlinkPath = join(value.root, "hardlink.sqlite");
  await link(value.path, hardlinkPath);
  assert.throws(() => new AcpSessionStore(hardlinkPath));
});
