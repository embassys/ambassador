import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationPreview,
  decorateConversationSessions,
} from "../src/desktop/conversation-preview.js";
import type { TranscriptItem } from "../src/visible-transcripts.js";

const items = [
  { kind: "turn", actionType: "get_free_busy_permission", status: "complete" },
  {
    kind: "entry",
    role: "user",
    text: JSON.stringify({ payload: { payload: { title: "Catch-up with Alex" } } }),
  },
  { kind: "entry", role: "tool", text: "Internal tool arguments" },
  { kind: "entry", role: "agent", text: "Alex is busy\n between 2 and 4 pm." },
] as TranscriptItem[];

test("conversation previews use saved fields and verbatim agent text without inferring identity", () => {
  assert.deepEqual(conversationPreview(items), {
    title: "Catch-up with Alex",
    excerpt: "Alex is busy between 2 and 4 pm.",
  });
  assert.equal(
    conversationPreview(items.filter((i) => i.kind !== "entry" || i.role !== "user"))?.title,
    "Calendar availability",
  );
  assert.equal(conversationPreview([]), undefined);
  assert.equal(
    conversationPreview([{ ...items[0], status: "expired" }] as TranscriptItem[]),
    undefined,
  );
  assert.doesNotMatch(JSON.stringify(conversationPreview(items)), /Internal tool|sender|email/);
  const long = [
    ...items.slice(0, 1),
    { kind: "entry", role: "agent", text: "🙂".repeat(400) },
  ] as TranscriptItem[];
  const preview = conversationPreview(long);
  assert.ok(preview && preview.excerpt.length <= 181);
  assert.doesNotMatch(preview.excerpt, /\uFFFD/);
});

test("preview enrichment is bounded, preserves session order and tolerates missing archives", () => {
  const sessions = Array.from({ length: 105 }, (_, n) => ({
    session_id: String(n),
    last_used_at_ms: n,
  }));
  const read: string[] = [];
  const enriched = decorateConversationSessions(sessions, (id) => {
    read.push(id);
    if (id === "50") throw new Error("Unavailable archive");
    return { title: "Phone number", excerpt: "Saved words" };
  });
  assert.equal(read.length, 100);
  assert.equal(read[0], "104");
  assert.deepEqual(
    enriched.map((s) => s.session_id),
    sessions.map((s) => s.session_id),
  );
  assert.equal(enriched[0]?.preview, undefined);
  assert.equal(enriched[50]?.preview, undefined);
  assert.equal(enriched[100]?.preview?.title, "Phone number");
  assert.ok(sessions[100]);
  assert.equal("preview" in sessions[100], false);
});
