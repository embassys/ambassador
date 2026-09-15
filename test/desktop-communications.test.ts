import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountConversations,
  combineConversation,
  mergeCommunicationPages,
} from "../src/desktop/account-conversations.js";
import { communicationsPage } from "../src/desktop/owner-contract.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const own = { agent_id: id(1), email: "me@example.test", display_name: "Me", is_mine: true };
const peer = { agent_id: id(2), email: "alex@example.test", display_name: "Alex", is_mine: false };
const item = (n: number) => ({
  message_id: id(n),
  call_id: id(9),
  message_type: "action_call",
  action_type: "get_phone_number",
  direction: "inbound" as const,
  sender: peer,
  sender_deleted: false,
  recipient: own,
  payload: {
    type: "action_call",
    call_id: id(9),
    action_type: "get_phone_number",
    payload: { reason: "Contact Alex" },
  },
  status: "queued",
  created_at: "2026-09-15T10:00:00Z",
  delivered_at: null,
  acked_at: null,
  call_status: "pending",
});
const page = (items: import("../src/desktop/owner-contract.js").Communication[] = [item(10)]) => ({
  items,
  has_more: false,
  next_cursor: null,
  retention: {
    complete_since: "2026-09-01T00:00:00Z",
    acked_messages_removed_after_days: 14,
    dead_messages_removed_after_days: 90,
    may_be_incomplete: true,
  },
});

test("history validates direction, deleted senders, unique message IDs and cursor consistency", () => {
  const raw = page();
  assert.equal(communicationsPage.parse(raw).items.length, 1);
  for (const broken of [
    { ...raw, has_more: true },
    { ...raw, items: [], has_more: true, next_cursor: "empty-page" },
    { ...raw, next_cursor: "orphan" },
    { ...raw, items: [item(10), item(10)] },
    { ...raw, items: [{ ...item(10), direction: "outbound" }] },
    { ...raw, items: [{ ...item(10), sender: null }] },
    { ...raw, items: [{ ...item(10), created_at: "2026-09-15T10:00:00" }] },
  ])
    assert.equal(communicationsPage.safeParse(broken).success, false);
  assert.equal(
    communicationsPage.safeParse(page([{ ...item(10), call_id: "old-malformed-call" }])).success,
    true,
  );
  assert.equal(
    communicationsPage.safeParse({
      ...raw,
      items: [{ ...item(10), sender: null, sender_deleted: true }],
    }).success,
    true,
  );
});

test("history pages deduplicate updates, preserve older pages and bound memory", () => {
  const old = page([item(10), item(11)]);
  const newer = page([{ ...item(10), status: "acked" }]);
  const merged = mergeCommunicationPages(old, newer, "refresh");
  assert.equal(merged.items.length, 2);
  assert.equal(merged.items.find((i) => i.message_id === id(10))?.status, "acked");
  assert.equal(mergeCommunicationPages(old, page([item(12)]), "refresh").items.length, 1);
  assert.throws(() =>
    mergeCommunicationPages(
      old,
      { ...newer, next_cursor: "same", has_more: true },
      "earlier",
      new Set(["same"]),
    ),
  );
});

test("account conversations use exact pairs, preserve deleted senders and avoid ambiguous local merges", () => {
  const raw = page([
    item(10),
    { ...item(11), direction: "outbound", sender: own, recipient: peer },
  ]);
  const sessions = accountConversations([], raw, undefined);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.peer?.email, peer.email);
  assert.equal(sessions[0]?.accountMessages?.length, 2);
  const local = {
    session_id: "local",
    agent_kind: "claude_code",
    status: "active",
    last_used_at_ms: 0,
    preview: { title: "Phone", excerpt: "", peer: { agentId: peer.agent_id, messageId: id(10) } },
  };
  assert.equal(accountConversations([local], raw, own.agent_id).length, 1);
  assert.equal(
    accountConversations([local, { ...local, session_id: "another" }], raw, own.agent_id).length,
    3,
  );
  assert.equal(accountConversations([local], raw, id(50)).length, 2);
  const deleted = communicationsPage.parse({
    ...page(),
    items: [{ ...item(10), sender: null, sender_deleted: true }],
  });
  assert.equal(accountConversations([], deleted, undefined)[0]?.peer?.name, "Deleted agent");
});

test("combined history removes duplicate incoming envelopes but keeps local agent output", () => {
  const local = {
    source: "archive" as const,
    items: [
      {
        kind: "entry" as const,
        id: "incoming",
        sessionId: "s",
        messageId: id(10),
        role: "user" as const,
        text: "{}",
        createdAt: 0,
      },
      {
        kind: "entry" as const,
        id: "response",
        sessionId: "s",
        messageId: id(10),
        role: "agent" as const,
        text: "I'll ask Alex.",
        createdAt: 1,
      },
    ],
    hasMore: false,
    nextCursor: 0,
    warnings: [],
  };
  const result = combineConversation(local, [item(10)], "s");
  assert.equal(result.items.length, 2);
  assert(result.items.some((i) => i.id === "response"));
  assert.equal(
    result.items.filter((i) => i.messageId === id(10) && i.kind === "entry" && i.role === "user")
      .length,
    1,
  );
});

test("internal traffic keeps a stable pair and deleted senders never acquire an unknown local identity", () => {
  const other = { ...peer, is_mine: true };
  const internal = communicationsPage.parse({
    ...page(),
    items: [
      { ...item(10), direction: "internal", sender: own, recipient: other },
      { ...item(11), direction: "internal", sender: other, recipient: own },
    ],
  });
  assert.equal(accountConversations([], internal, undefined).length, 1);
  const deleted = communicationsPage.parse({
    ...page(),
    items: [{ ...item(10), sender: null, sender_deleted: true }],
  });
  assert.equal(
    accountConversations(
      [{ session_id: "unknown-local", agent_kind: "codex", status: "active", last_used_at_ms: 0 }],
      deleted,
      own.agent_id,
    ).length,
    2,
  );
});

test("history enforces record and byte bounds while treating tied timestamps deterministically", () => {
  const old = page(Array.from({ length: 1000 }, (_, i) => item(100 + i)));
  assert.throws(() => mergeCommunicationPages(old, page([item(2000)]), "earlier"), /full/);
  const huge = page([{ ...item(2001), payload: { text: "x".repeat(8 * 1024 * 1024) } }]);
  assert.throws(() => mergeCommunicationPages(page(), huge, "earlier"), /full/);
  const first = mergeCommunicationPages(page([item(10)]), page([item(11)]), "earlier");
  const second = mergeCommunicationPages(page([item(11)]), page([item(10)]), "earlier");
  assert.deepEqual(
    first.items.map((i) => i.message_id),
    second.items.map((i) => i.message_id),
  );
});
