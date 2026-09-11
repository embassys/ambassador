import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chronologicalItems,
  conversationPeer,
  incomingMessage,
  mergeChatPages,
} from "../src/desktop/chat.js";
import type { TranscriptItem } from "../src/visible-transcripts.js";

test("peer names require the same owner and exact inbound message ID; ambiguous identities fall back", () => {
  const peer = { agentId: "peer-1", messageId: "message-1" };
  const messages = [
    { id: "message-1", outbound: false, sender_name: "Alex", sender_email: "alex@example.test" },
  ];
  const first = messages[0];
  assert.ok(first);
  assert.equal(conversationPeer(peer, messages, true).name, "Alex");
  assert.equal(conversationPeer(peer, messages, true).email, "alex@example.test");
  assert.equal(conversationPeer(peer, messages, false).email, undefined);
  assert.equal(conversationPeer(peer, [{ ...first, id: "other" }], true).email, undefined);
  assert.equal(conversationPeer(peer, [{ ...first, outbound: true }], true).email, undefined);
  assert.equal(
    conversationPeer(peer, [...messages, { ...first, sender_email: "wrong@example.test" }], true)
      .email,
    undefined,
  );
  assert.equal(conversationPeer(undefined, messages, true).name, "Unknown agent");
});

test("chronological chat preserves equal-time order and leaves source data untouched", () => {
  const items = [
    { id: "later", createdAt: 3 },
    { id: "first", createdAt: 1 },
    { id: "tie", createdAt: 1 },
  ] as TranscriptItem[];
  assert.deepEqual(
    chronologicalItems(items).map((i) => i.id),
    ["first", "tie", "later"],
  );
  assert.equal(items[0]?.id, "later");
});

test("owner answers and status notifications are never attributed to the remote agent", () => {
  const message = (type: string) =>
    JSON.stringify({
      payload: {
        type,
        question: "Which time?",
        value: "4 pm",
        action_type: "get_phone_number",
        payload: { reason: "Call me" },
      },
    });
  assert.equal(incomingMessage(message("action_call")).side, "peer");
  assert.equal(incomingMessage(message("action_response")).side, "peer");
  assert.equal(incomingMessage(message("owner_input")).side, "owner");
  assert.equal(incomingMessage(message("permission_outcome")).side, "system");
  assert.equal(incomingMessage(message("unknown")).side, "system");
  assert.equal(incomingMessage("{broken").side, "system");
});

test("refresh retains a bounded reading window, updates existing messages and clears missing history", () => {
  const page = (ids: string[]) => ({
    source: "archive" as const,
    items: ids.map((id, n) => ({
      id,
      kind: "entry",
      role: "agent",
      text: id,
      createdAt: n,
    })) as TranscriptItem[],
    nextCursor: 10,
    hasMore: true,
    warnings: [],
  });
  const old = page(["a", "b", "c"]);
  const next = page(["b", "c", "d"]);
  const merged = mergeChatPages(old, next, "refresh");
  assert.deepEqual(
    merged.items.map((i) => i.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(mergeChatPages(old, page([]), "refresh").items, []);
  assert.deepEqual(
    mergeChatPages(old, page(["new"]), "refresh").items.map((i) => i.id),
    ["new"],
  );
  assert.deepEqual(
    mergeChatPages(old, page(["earlier"]), "earlier").items.map((i) => i.id),
    ["earlier", "a", "b", "c"],
  );
  assert.equal(
    mergeChatPages(
      page(Array.from({ length: 500 }, (_, n) => String(n))),
      page(["499", "500"]),
      "refresh",
    ).items.length,
    500,
  );
});
