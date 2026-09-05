import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ActionResultInbox } from "../src/action-result-inbox.js";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { LocalInbox } from "../src/local-inbox.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-paged-inbox-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const calls = new PendingActionInbox(join(root, "calls.sqlite"), credential);
  const results = new ActionResultInbox(join(root, "results.sqlite"), credential);
  t.after(async () => {
    calls.close();
    results.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, results, inbox: new LocalInbox(calls, results) };
}

function message(index: number, result = false, bytes = 8): CentralMessage {
  const callId = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  return {
    id: `message.${index}`,
    sender_agent_id: "agent.peer",
    created_at: "2026-09-05T01:00:00Z",
    payload: result
      ? {
          type: "action_response",
          call_id: callId,
          action_type: "lookup",
          status: "success",
          result: { answer: "x".repeat(bytes) },
        }
      : {
          type: "action_call",
          call_id: callId,
          action_type: "lookup",
          payload: { query: "x".repeat(bytes) },
        },
  };
}

test("pages a combined inbox larger than one MCP response without losing unread results", async (t) => {
  const { calls, results, inbox } = await fixture(t);
  calls.capture(message(1, false, 300 * 1024));
  results.capture(message(2, true, 300 * 1024));
  const first = inbox.get({ limit: 1 });
  assert.equal(first.count, 1);
  assert.equal(results.list().length, 1);
  assert.equal(typeof first.next_cursor, "string");
  const second = inbox.get({ cursor: first.next_cursor });
  assert.equal(second.count, 1);
  assert.equal(second.items[0]?.kind, "action_result");
  assert.equal(results.list().length, 1);
  assert.deepEqual(inbox.get({ cursor: first.next_cursor }).items, second.items);
  assert.equal(calls.list().length, 1);
});

test("retains results when response validation or cancellation fails", async (t) => {
  const { results, inbox } = await fixture(t);
  results.capture(message(1, true));
  assert.throws(() =>
    inbox.get(
      {},
      {
        validate: () => {
          throw new Error("response rejected");
        },
      },
    ),
  );
  assert.equal(results.list().length, 1);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => inbox.get({}, { signal: controller.signal }));
  assert.equal(results.list().length, 1);
  assert.equal(inbox.get({}).count, 1);
});

test("supports more than 256 records and the former byte quota with bounded pages", async (t) => {
  const { calls, inbox } = await fixture(t);
  for (let index = 1; index <= 300; index += 1) calls.capture(message(index, false, 4096));
  let cursor: unknown;
  const ids = new Set<string>();
  do {
    const page = inbox.get(cursor === undefined ? { limit: 17 } : { limit: 17, cursor });
    assert.ok(page.items.length <= 17);
    for (const item of page.items) {
      assert.equal(ids.has(String(item.call_id)), false);
      ids.add(String(item.call_id));
    }
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  assert.equal(ids.size, 300);
  assert.throws(() => inbox.get({ cursor: "not-a-cursor" }));
  assert.throws(() => inbox.get({ limit: 0 }));
});
