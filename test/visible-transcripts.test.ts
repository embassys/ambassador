import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { VisibleTranscripts } from "../src/visible-transcripts.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

const message = {
  id: "message-1",
  sender_agent_id: "peer-1",
  payload: {
    type: "action_call",
    call_id: "call-1",
    action_type: "get_phone_number",
    payload: { reason: "visible request" },
  },
  created_at: "2026-09-07T10:00:00Z",
};
const text = (value: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});

test("latest conversation pages walk backward within one session without gaps or replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-chat-pages-"));
  let now = Date.parse("2026-09-11T10:00:00Z");
  const archive = new VisibleTranscripts(
    join(root, "visible.sqlite"),
    parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS),
    { now: () => now },
  );
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let n = 0; n < 12; n++) {
    const msg = { ...message, id: `message-${n}` };
    archive.begin("session", msg);
    now++;
    archive.update(msg.id, 1, text(`Reply ${n}`));
    archive.finish(msg.id, "complete");
    now++;
  }
  archive.begin("another-session", { ...message, id: "other" });
  const first = archive.latest("session", undefined, 5);
  assert.match(JSON.stringify(first), /Reply 11/);
  assert.doesNotMatch(JSON.stringify(first), /Reply 0"|"id":"other"/);
  assert.equal(first.hasMore, true);
  const collected = [...first.items];
  let page = first;
  while (page.hasMore) {
    const previous = page.nextCursor;
    page = archive.latest("session", previous, 5);
    assert.ok(page.nextCursor < previous);
    collected.unshift(...page.items);
  }
  assert.deepEqual(
    collected.map((i) => i.id),
    archive.page("session").items.map((i) => i.id),
  );
  assert.equal(new Set(collected.map((i) => i.id)).size, collected.length);
  assert.throws(() => archive.latest("session", -1));
  assert.deepEqual(archive.latest("missing").items, []);
  now += 31 * 86_400_000;
  assert.ok(
    archive.latest("session").items.every((i) => i.kind === "turn" && i.status === "expired"),
  );
});

test("visible transcripts normalize chunks, exclude reasoning and replay, and survive restart encrypted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-visible-"));
  const path = join(root, "visible.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let archive = new VisibleTranscripts(path, credential);
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  archive.begin("session-1", message);
  archive.update(message.id, 1, text("The number "));
  archive.update(message.id, 1, text("The number "));
  archive.update(message.id, 2, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "PRIVATE REASONING" },
  });
  archive.update(message.id, 3, text("is +44 7700 900627."));
  archive.update(message.id, 4, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "provider replay" },
  });
  archive.finish(message.id, "complete");
  archive.close();
  archive = new VisibleTranscripts(path, credential);
  const preview = archive.preview("session-1");
  assert.equal(preview?.title, "Phone number");
  assert.match(preview?.excerpt ?? "", /The number is/);
  assert.equal(archive.preview("other-session"), undefined);
  const page = archive.page("session-1");
  const serialized = JSON.stringify(page);
  assert.match(serialized, /The number is \+44 7700 900627/u);
  assert.doesNotMatch(serialized, /PRIVATE REASONING|provider replay/u);
  assert.equal(
    page.items.filter((item) => item.kind === "entry" && item.role === "agent").length,
    1,
  );
  assert.equal(archive.page("other-session").items.length, 0);
  archive.close();
  assert.doesNotMatch((await readFile(path)).toString(), /visible request|7700|PRIVATE REASONING/u);
});

test("large text paginates without splitting Unicode, and interrupted turns remain visibly partial", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-visible-pages-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const archive = new VisibleTranscripts(join(root, "visible.sqlite"), credential);
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  archive.begin("session", message);
  const value = "🙂á".repeat(50_000);
  archive.update(message.id, 1, text(value));
  archive.recoverInterrupted();
  let after = 0;
  let result = "";
  let hasMore = true;
  while (hasMore) {
    const page = archive.page("session", after, 3);
    for (const item of page.items)
      if (item.kind === "entry" && item.role === "agent") result += item.text;
    hasMore = page.hasMore;
    after = page.nextCursor;
  }
  assert.equal(result, value);
  assert.match(JSON.stringify(archive.page("session")), /partial/u);
});

test("retention removes settled bodies, keeps a gap, and does not evict an active turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-visible-retention-"));
  let now = Date.parse("2026-09-07T10:00:00Z");
  const archive = new VisibleTranscripts(
    join(root, "visible.sqlite"),
    parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS),
    { now: () => now },
  );
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  archive.begin("session", message);
  archive.update(message.id, 1, text("settled old body"));
  archive.finish(message.id, "complete");
  archive.begin("session", { ...message, id: "message-2" });
  archive.update("message-2", 1, text("active body"));
  now += 31 * 86_400_000;
  for (let attempt = 0; attempt < 5; attempt++) archive.maintain();
  const page = JSON.stringify(archive.page("session"));
  assert.doesNotMatch(page, /settled old body/u);
  assert.match(page, /retention/u);
  assert.match(page, /active body/u);
  assert.doesNotMatch(JSON.stringify(archive.preview("session")), /settled old body/u);
  while (archive.deleteSession("session")) {}
  assert.equal(archive.preview("session"), undefined);
});

test("quota failure records a durable gap without altering workflow or hiding a failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-visible-quota-"));
  const path = join(root, "visible.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let archive = new VisibleTranscripts(path, credential, { maximumBytes: 4000 });
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  archive.begin("session", message);
  assert.equal(archive.update(message.id, 1, text("x".repeat(20_000))), false);
  assert.ok(archive.page("session").warnings.length > 0);
  archive.finish(message.id, "complete");
  assert.match(JSON.stringify(archive.page("session").items), /partial/u);
  archive.close();
  archive = new VisibleTranscripts(path, credential, { maximumBytes: 4000 });
  assert.ok(archive.page("session").warnings.length > 0);
  archive.close();
});

test("streamed tool updates become one summary per call and survive restart without raw arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-visible-tools-"));
  const path = join(root, "visible.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let archive = new VisibleTranscripts(path, credential);
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  archive.begin("session", message);
  archive.update(message.id, 1, {
    sessionUpdate: "tool_call",
    toolCallId: "a",
    title: "Message Box",
    status: "pending",
  });
  archive.update(message.id, 2, {
    sessionUpdate: "tool_call_update",
    toolCallId: "a",
    title: "Message Box",
    rawInput: { result: "private-argument-marker" },
  });
  archive.update(message.id, 3, {
    sessionUpdate: "tool_call",
    toolCallId: "b",
    title: "Read inbox",
    status: "pending",
  });
  archive.close();
  archive = new VisibleTranscripts(path, credential);
  archive.update(message.id, 4, {
    sessionUpdate: "tool_call_update",
    toolCallId: "a",
    status: "completed",
  });
  archive.update(message.id, 5, text("The result was sent."));
  archive.finish(message.id, "complete");
  const tools = archive
    .page("session")
    .items.filter((item) => item.kind === "entry" && item.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.kind === "entry" && tools[0].text, "Message Box\ncompleted");
  assert.equal(tools[1]?.kind === "entry" && tools[1].text, "Read inbox\npending");
  assert.doesNotMatch(JSON.stringify(archive.page("session")), /private-argument-marker/);
});
