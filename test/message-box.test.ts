import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ActionResultInbox } from "../src/action-result-inbox.js";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { EncryptedRecordStore } from "../src/encrypted-record-store.js";
import { MESSAGE_BOX_TOOL, MessageBox } from "../src/message-box.js";
import { OutboundActions } from "../src/outbound-actions.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

async function fixture(t: TestContext, granted = false, waitMs = 35) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-message-box-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const permissionId = randomUUID();
  const callId = randomUUID();
  let requests = 0;
  let calls = 0;
  let replies = 0;
  let afterPermission: (() => void) | undefined;
  const transport = {
    async listActionTypes() {
      return [
        {
          id: "lookup-type",
          name: "lookup",
          description: "Lookup",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ];
    },
    async requestPermission() {
      requests += 1;
      afterPermission?.();
      return {
        permission_id: permissionId,
        status: granted ? ("granted" as const) : ("pending" as const),
        message: "Queued",
      };
    },
    async callAction(value: Record<string, unknown>) {
      calls += 1;
      assert.equal(value.action_type, "lookup");
      assert.deepEqual(value.payload, { query: "saved private intent" });
      return { call_id: callId, message_id: randomUUID(), status: "delivered" };
    },
    async submitActionResult() {
      replies += 1;
      return { call_id: callId, message_id: randomUUID(), status: "completed" };
    },
  };
  const outbound = new OutboundActions(join(root, "outbound.sqlite"), credential, transport);
  const pending = new PendingActionInbox(join(root, "pending.sqlite"), credential);
  const results = new ActionResultInbox(join(root, "results.sqlite"), credential);
  const options = {
    path: join(root, "operations.sqlite"),
    credential,
    transport,
    outbound,
    pending,
    results,
    waitMs,
  };
  let box = new MessageBox(options);
  t.after(async () => {
    await box.close();
    outbound.close();
    pending.close();
    results.close();
    await rm(root, { recursive: true, force: true });
  });
  const outcome: CentralMessage = {
    id: randomUUID(),
    sender_agent_id: "peer",
    action_type_id: "lookup-type",
    created_at: new Date().toISOString(),
    payload: {
      type: "permission_outcome",
      permission_id: permissionId,
      action_type: "lookup",
      grantor_email: "peer@example.test",
      status: "granted",
      granted: true,
    },
  };
  return {
    root,
    pending,
    outcome,
    callId,
    afterPermission(callback: () => void) {
      afterPermission = callback;
    },
    get box() {
      return box;
    },
    get requests() {
      return requests;
    },
    get calls() {
      return calls;
    },
    get replies() {
      return replies;
    },
    async restart() {
      await box.close();
      box = new MessageBox(options);
    },
    async capture(message: CentralMessage) {
      return await box.capture(message);
    },
    async loseOperationBinding(requestId: string) {
      await box.close();
      const store = new EncryptedRecordStore<Record<string, unknown>>(options.path, credential, {
        scope: "ambassador-message-box",
        identifier: (value) => String(value.request_id),
        parse: (bytes) => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
        error: () => new Error("fixture operation invalid"),
      });
      const value = store.get(requestId);
      assert.ok(value);
      delete value.call_id;
      delete value.permission_id;
      value.status = "submitting";
      store.put(value, { replace: true });
      store.close();
      box = new MessageBox(options);
    },
    result(): CentralMessage {
      return {
        ...outcome,
        id: randomUUID(),
        payload: {
          type: "action_response",
          call_id: callId,
          action_type: "lookup",
          status: "success",
          result: { answer: "private result" },
        },
      };
    },
  };
}

const request = () => ({
  type: "request_action",
  request_id: randomUUID(),
  target_email: "peer@example.test",
  action_type: "lookup",
  payload: { query: "saved private intent" },
});

test("inbox reconciles a completed reply after interruption before pending-call cleanup", async (t) => {
  const f = await fixture(t);
  const message: CentralMessage = {
    ...f.outcome,
    payload: {
      type: "action_call",
      call_id: f.callId,
      action_type: "lookup",
      payload: { query: "saved private intent" },
    },
  };
  await f.capture(message);
  const reply = {
    type: "submit_action_result",
    request_id: randomUUID(),
    call_id: f.callId,
    status: "success",
    result: { answer: "completed" },
  };
  await f.box.call(reply, new AbortController().signal);
  // Restore the state that a crash between saving completion and removal leaves.
  f.pending.capture(message);
  await f.restart();
  assert.equal(f.pending.get(f.callId)?.call_id, f.callId);
  assert.deepEqual(await f.box.call({ type: "inbox" }, new AbortController().signal), {
    count: 0,
    items: [],
  });
  assert.equal(f.pending.get(f.callId), undefined);
  await f.box.call(reply, new AbortController().signal);
  assert.equal(f.replies, 1);
});

test("a local cleanup failure cannot replace a saved successful reply with uncertainty", async (t) => {
  const f = await fixture(t);
  await f.capture({
    ...f.outcome,
    payload: { type: "action_call", call_id: f.callId, action_type: "lookup", payload: {} },
  });
  const remove = f.pending.remove.bind(f.pending);
  f.pending.remove = () => {
    throw new Error("synthetic cleanup failure");
  };
  const reply = {
    type: "submit_action_result",
    request_id: randomUUID(),
    call_id: f.callId,
    status: "success",
    result: { answer: "completed" },
  };
  await assert.rejects(f.box.call(reply, new AbortController().signal));
  f.pending.remove = remove;
  await f.restart();
  const result = await f.box.call(reply, new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.equal(f.replies, 1);
});

test("the tool publishes visible message fields even when a provider simplifies union schemas", () => {
  const properties = MESSAGE_BOX_TOOL.inputSchema.properties as Record<string, unknown>;
  assert.ok(properties);
  for (const field of ["type", "request_id", "call_id", "question", "payload", "wait_seconds"])
    assert.ok(properties[field]);
  assert.deepEqual(MESSAGE_BOX_TOOL.inputSchema.required, ["type"]);
  assert.ok(Array.isArray(MESSAGE_BOX_TOOL.inputSchema.oneOf));
  const wait = properties.wait_seconds as Record<string, unknown>;
  assert.match(String(wait.description), /Omit.*600 seconds/u);
  assert.match(String(wait.description), /known.*client.*limit/u);
  assert.match(
    MESSAGE_BOX_TOOL.description ?? "",
    /Do not schedule a background check unless the user asks/u,
  );
});

test("initial call long polls, timeout preserves intent, and a grant submits exactly once", async (t) => {
  const f = await fixture(t);
  const input = request();
  const started = performance.now();
  const first = await f.box.call(input, new AbortController().signal);
  assert.ok(performance.now() - started >= 25);
  assert.equal(first.reason, "wait_timeout");
  assert.equal(f.requests, 1);
  assert.equal(f.calls, 0);
  await f.restart();
  await f.capture(f.outcome);
  const grant = await f.box.call(
    { type: "check", request_id: input.request_id },
    new AbortController().signal,
  );
  assert.equal((grant.events as Array<{ type: string }>)[0]?.type, "permission_status");
  assert.equal(f.calls, 1);
  await f.box.call(input, new AbortController().signal);
  assert.equal(f.requests, 1);
  assert.equal(f.calls, 1);
  await assert.rejects(
    f.box.call({ ...input, payload: { query: "changed" } }, new AbortController().signal),
    { code: "request_id_conflict" },
  );
  const next = f.box.call(
    { type: "check", request_id: input.request_id, cursor: grant.cursor },
    new AbortController().signal,
  );
  await f.capture(f.result());
  const result = await next;
  assert.equal((result.events as Array<{ type: string }>)[0]?.type, "action_result");
  assert.match(JSON.stringify(result), /private result/u);
  await f.restart();
  assert.match(
    JSON.stringify(
      await f.box.call(
        { type: "check", request_id: input.request_id },
        new AbortController().signal,
      ),
    ),
    /private result/u,
  );
  await f.box.call(
    { type: "acknowledge", request_id: input.request_id, cursor: result.cursor },
    new AbortController().signal,
  );
  const acknowledged = await f.box.call(
    { type: "check", request_id: input.request_id },
    new AbortController().signal,
  );
  assert.equal(acknowledged.status, "completed");
  assert.doesNotMatch(JSON.stringify(acknowledged), /private result/u);
  assert.equal(
    (await readFile(join(f.root, "operations.sqlite"))).includes(Buffer.from("peer@example.test")),
    false,
  );
});

test("existing grants still wait for a result and ignore unrelated outcomes", async (t) => {
  const f = await fixture(t, true);
  const input = request();
  const waiting = f.box.call(input, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    await f.capture({ ...f.outcome, payload: { ...f.outcome.payload, action_type: "other" } }),
    false,
  );
  const first = await waiting;
  assert.equal(first.reason, "wait_timeout");
  assert.equal(f.calls, 1);
  await f.capture(f.result());
  const result = await f.box.call(
    { type: "check", request_id: input.request_id },
    new AbortController().signal,
  );
  assert.equal(result.status, "completed");
});

test("disconnect cancels observation without losing or resubmitting the accepted request", async (t) => {
  const f = await fixture(t, false, 5_000);
  const input = request();
  const controller = new AbortController();
  const waiting = f.box.call(input, controller.signal);
  // Disconnect after acceptance, independently of schema worker startup time.
  while (f.requests === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(f.requests, 1);
  await f.capture(f.outcome);
  assert.equal(
    (
      await f.box.call(
        { type: "check", request_id: input.request_id },
        new AbortController().signal,
      )
    ).status,
    "pending",
  );
  assert.equal(f.requests, 1);
});

test("shorter waits do not change request identity or consume unrelated tool capacity", async (t) => {
  const f = await fixture(t);
  const input = request();
  const signal = new AbortController().signal;
  const first = await f.box.call({ ...input, wait_seconds: 0 }, signal);
  assert.equal(first.reason, "wait_timeout");
  const next = await f.box.call({ ...input, wait_seconds: 1 }, signal);
  assert.equal(next.request_id, first.request_id);
  assert.equal(f.requests, 1);
  await assert.rejects(
    f.box.call({ type: "check", request_id: input.request_id, wait_seconds: 601 }, signal),
    { code: "invalid_arguments" },
  );
});

test("result reads survive disconnects and duplicate receipts remain harmless", async (t) => {
  const f = await fixture(t, true);
  const input = request();
  const signal = new AbortController().signal;
  await f.box.call(input, signal);
  await f.capture(f.result());
  const result = await f.box.call({ type: "check", request_id: input.request_id }, signal);
  const receipt = { type: "acknowledge", request_id: input.request_id, cursor: result.cursor };
  await f.box.call(receipt, signal);
  await f.restart();
  await f.box.call(receipt, signal);
  assert.deepEqual((await f.box.call({ type: "inbox" }, signal)).items, []);
  await f.capture(f.result());
  assert.deepEqual((await f.box.call({ type: "inbox" }, signal)).items, []);
  await assert.rejects(f.box.call({ ...receipt, cursor: randomUUID() }, signal), {
    code: "cursor_invalid",
  });
});

test("restart recovers saved submission identifiers before a result without replaying work", async (t) => {
  const f = await fixture(t, true);
  const input = request();
  const signal = new AbortController().signal;
  await f.box.call(input, signal);
  await f.loseOperationBinding(input.request_id);
  assert.equal(await f.capture(f.result()), true);
  const result = await f.box.call({ type: "check", request_id: input.request_id }, signal);
  assert.equal(result.status, "completed");
  assert.match(JSON.stringify(result), /private result/);
  assert.equal(f.calls, 1);
  assert.equal(f.requests, 1);
});

test("restart binds a saved pending permission before processing its later grant", async (t) => {
  const f = await fixture(t);
  const input = request();
  const signal = new AbortController().signal;
  await f.box.call(input, signal);
  await f.loseOperationBinding(input.request_id);
  assert.equal(await f.capture(f.outcome), true);
  assert.equal(f.calls, 1);
  assert.equal(f.requests, 1);
});

test("a check continues a granted but never dispatched intent after interruption", async (t) => {
  const f = await fixture(t, true);
  const input = request();
  const controller = new AbortController();
  f.afterPermission(() => controller.abort());
  await assert.rejects(f.box.call(input, controller.signal));
  assert.equal(f.calls, 0);
  await f.restart();
  const signal = new AbortController().signal;
  const result = await f.box.call(
    { type: "check", request_id: input.request_id, wait_seconds: 0 },
    signal,
  );
  assert.equal(result.status, "pending");
  assert.equal(result.call_id, f.callId);
  assert.equal((result.events as { type: string }[]).at(-1)?.type, "operation_status");
  assert.equal(f.calls, 1);
  assert.equal(f.requests, 1);
  await f.box.call({ ...input, wait_seconds: 0 }, signal);
  assert.equal(f.calls, 1);
});
