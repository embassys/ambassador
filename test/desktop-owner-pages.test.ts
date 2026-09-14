import assert from "node:assert/strict";
import { test } from "node:test";
import { collectOwnerRequests } from "../src/desktop/owner-pages.js";
import type { OwnerReply } from "../src/desktop/owner-protocol.js";

const context = "00000000-0000-4000-8000-000000000011";
function page(cursor: string | null, ids: string[]): OwnerReply {
  return {
    state: "ready",
    snapshot: { context, status: "signed_in" },
    data: {
      kind: "requests",
      total: ids.length,
      permission_requests: [],
      input_requests: ids.map((id) => ({
        id,
        input_type: "text",
        options: null,
        prompt: "Question",
        action_type: "read",
        created_at: "2026-09-14T12:00:00Z",
      })),
      next_cursor: cursor,
      has_more: cursor !== null,
      watermark: 10,
    },
  };
}
test("conversation requests span pages and deduplicate a request repeated across a changing snapshot", async () => {
  let count = 0;
  const result = await collectOwnerRequests(context, async (command) => {
    assert.equal(command.type, "owner_requests");
    return ++count === 1 ? page("next", ["a", "b"]) : page(null, ["b", "c"]);
  });
  assert.equal(count, 2);
  assert.equal(result.data?.kind, "requests");
  if (result.data?.kind === "requests") {
    assert.deepEqual(
      result.data.input_requests.map((item) => item.id),
      ["a", "b", "c"],
    );
    assert.equal(result.data.total, 3);
  }
});
test("a repeated cursor or a different account cannot silently corrupt the conversation inbox", async () => {
  await assert.rejects(collectOwnerRequests(context, async () => page("same", [])));
  await assert.rejects(
    collectOwnerRequests(context, async () => ({
      ...page(null, []),
      snapshot: { context: "changed", status: "signed_in" },
    })),
  );
});
