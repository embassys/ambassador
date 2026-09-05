import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { OutboundActions } from "../src/outbound-actions.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

const arguments_ = {
  target_email: "peer@fixture.test",
  action_type: "lookup",
  action_payload: { query: "exact private intent" },
};
const outcome: CentralMessage = {
  id: "outcome",
  sender_agent_id: "central-peer-id",
  created_at: "2026-09-05T00:00:00Z",
  payload: {
    type: "permission_outcome",
    permission_id: "permission-1",
    grantor_email: "peer@fixture.test",
    action_type: "lookup",
    granted: true,
    status: "granted",
  },
};

async function fixture(t: TestContext, fail = false, granted = false) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-outbound-"));
  const path = join(root, "outbound.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const requests: Record<string, unknown>[] = [];
  const calls: Record<string, unknown>[] = [];
  const transport = {
    async requestPermission(value: Record<string, unknown>) {
      requests.push(value);
      return {
        permission_id: "permission-1",
        status: granted ? ("granted" as const) : ("pending" as const),
        message: "permission status",
      };
    },
    async callAction(value: Record<string, unknown>) {
      calls.push(value);
      if (fail) throw new Error("connection lost");
      return {
        call_id: "10000000-0000-4000-8000-000000000001",
        message_id: "message-1",
        status: "delivered",
      };
    },
  };
  let store = new OutboundActions(path, credential, transport);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    path,
    requests,
    calls,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new OutboundActions(path, credential, transport);
    },
  };
}

test("records encrypted intent before requesting permission and dispatches its exact payload once", async (t) => {
  const value = await fixture(t);
  await value.store.request(arguments_);
  assert.deepEqual(value.requests, [
    { target_email: arguments_.target_email, action_type: "lookup" },
  ]);
  assert.equal(value.calls.length, 0);
  value.reopen();
  assert.equal((await readFile(value.path)).includes(Buffer.from("exact private intent")), false);
  await value.store.capture(outcome);
  await value.store.capture(outcome);
  await value.store.request(arguments_);
  assert.deepEqual(value.calls, [
    {
      target_email: arguments_.target_email,
      action_type: "lookup",
      payload: arguments_.action_payload,
    },
  ]);
  assert.equal(value.store.page().items[0]?.value.status, "submitted");
  await value.store.capture({
    ...outcome,
    payload: {
      type: "action_response",
      call_id: value.calls.length && "10000000-0000-4000-8000-000000000001",
      action_type: "lookup",
    },
  });
  assert.equal(value.store.page().items.length, 0);
});

test("keeps uncertain dispatches across restart without retrying or replacing their payload", async (t) => {
  const value = await fixture(t, true);
  await value.store.request(arguments_);
  await value.store.capture(outcome);
  value.reopen();
  await value.store.capture(outcome);
  await value.store.request(arguments_);
  assert.equal(value.calls.length, 1);
  assert.equal(value.store.page().items[0]?.value.status, "dispatch_uncertain");
  await assert.rejects(
    value.store.request({ ...arguments_, action_payload: { query: "different" } }),
  );
});

test("never invents intent for permission-only, denied, or mismatched outcomes", async (t) => {
  const value = await fixture(t);
  await value.store.request({ target_email: arguments_.target_email, action_type: "lookup" });
  await value.store.capture(outcome);
  assert.equal(value.calls.length, 0);
  await value.store.request(arguments_);
  await value.store.capture({
    ...outcome,
    payload: { ...outcome.payload, grantor_email: "someone-else@fixture.test" },
  });
  assert.equal(value.calls.length, 0);
  await value.store.capture({
    ...outcome,
    payload: { ...outcome.payload, granted: false, status: "denied" },
  });
  assert.equal(value.store.page().items[0]?.value.status, "denied");
  assert.equal(value.calls.length, 0);
  await value.store.request(arguments_);
  assert.equal(value.requests.length, 3);
  assert.equal(value.store.page().items[0]?.value.status, "awaiting_permission");
});

test("dispatches saved intent immediately when permission already exists", async (t) => {
  const value = await fixture(t, false, true);
  const response = await value.store.request(arguments_);
  assert.equal((response.outbound_action as Record<string, unknown>).status, "submitted");
  assert.equal(value.calls.length, 1);
  await value.store.request(arguments_);
  assert.equal(value.requests.length, 1);
  assert.equal(value.calls.length, 1);
});
