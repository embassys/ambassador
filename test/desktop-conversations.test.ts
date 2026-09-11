import assert from "node:assert/strict";
import { test } from "node:test";
import { groupConversationRequests, requestLinksPage } from "../src/desktop/conversations.js";

const sessions = [
  { session_id: "recent", last_used_at_ms: 30 },
  { session_id: "older", last_used_at_ms: 10 },
  { session_id: "middle", last_used_at_ms: 20 },
];
const requests = {
  kind: "requests" as const,
  total: 3,
  permission_requests: [{ id: "same" }],
  input_requests: [{ id: "same" }, { id: "missing" }],
};
test("only exact same-identity, kind-qualified, unambiguous links leave the request inbox", () => {
  const links = [{ kind: "input" as const, requestId: "same", sessionId: "older" }];
  const group = groupConversationRequests(sessions, requests, links, true);
  assert.deepEqual(
    group.sessions.map((s) => s.session_id),
    ["older", "recent", "middle"],
  );
  assert.equal(group.bySession.get("older")?.input_requests[0], requests.input_requests[0]);
  assert.deepEqual(group.inbox.permission_requests, requests.permission_requests);
  assert.deepEqual(group.inbox.input_requests, [requests.input_requests[1]]);
  assert.equal(group.inbox.total, 2);
  assert.equal(groupConversationRequests(sessions, requests, links, false).inbox.total, 3);
  assert.equal(groupConversationRequests([], requests, links, true).inbox.total, 3);
  const ambiguous = [...links, { kind: "input" as const, requestId: "same", sessionId: "recent" }];
  assert.equal(groupConversationRequests(sessions, requests, ambiguous, true).inbox.total, 3);
  assert.equal(
    groupConversationRequests(sessions, requests, [...links, ...links], true).inbox.total,
    2,
  );
  assert.equal(requests.total, 3);
  assert.equal(sessions[0]?.session_id, "recent");
});
test("uncertain submissions stay in inbox, and resolved requests no longer pin a conversation", () => {
  const data = { ...requests, unconfirmed: [{ id: "uncertain" }], unconfirmedMore: true };
  const grouped = groupConversationRequests(sessions, data, [], true);
  assert.deepEqual(grouped.inbox.unconfirmed, data.unconfirmed);
  assert.equal(grouped.inbox.unconfirmedMore, true);
  const pendingUncertain = { ...requests, unconfirmed: [{ id: "same", kind: "input" }] };
  const uncertain = groupConversationRequests(
    sessions,
    pendingUncertain,
    [{ kind: "input", requestId: "same", sessionId: "older" }],
    true,
  );
  assert.equal(uncertain.inbox.total, 3);
  assert.equal(uncertain.bySession.get("older")?.total, 0);

  assert.deepEqual(
    grouped.sessions.map((s) => s.session_id),
    ["recent", "middle", "older"],
  );
});
test("local question links use saved central IDs and exact dispatch lookup with bounded paging", () => {
  let limitSeen = 0;
  const page = requestLinksPage(
    {
      page: (after, limit) => {
        assert.equal(after, 50);
        limitSeen = limit;
        return {
          hasMore: true,
          items: [
            { sequence: 51, value: { remote_request_id: "remote", source_message_id: "message" } },
            { sequence: 52, value: { source_message_id: "lost-response" } },
            {
              sequence: 53,
              value: { remote_request_id: "orphan", source_message_id: "untracked" },
            },
          ],
        };
      },
    },
    (message) => (message === "message" ? "older" : undefined),
    "enrolled-owner",
    50,
  );
  assert.equal(limitSeen, 100);
  assert.deepEqual(page.links, [{ kind: "input", requestId: "remote", sessionId: "older" }]);
  assert.equal(page.agentId, "enrolled-owner");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 53);
});
