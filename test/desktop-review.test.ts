import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesktopCommand } from "../src/desktop/protocol.js";
import { DesktopReviews, type ReviewRequest } from "../src/desktop/review.js";

const request: ReviewRequest = {
  kind: "permission",
  instanceName: "My device",
  permission: {
    title: "mcp__ambassador__get_my_permissions",
    detail: '{"rawInput":{"setup_check":"opaque"}}',
    options: [
      { optionId: "provider:once", name: "Only this invocation", kind: "allow_once" },
      {
        optionId: "provider:always",
        name: "Allow all matching future invocations",
        kind: "allow_always",
      },
    ],
  },
};

test("desktop review returns the exact selected ID and ignores stale or invented responses", async () => {
  const reviews = new DesktopReviews(() => {});
  const waiting = reviews.ask(request);
  const first = reviews.current();
  assert.ok(first);
  assert.equal(reviews.answer("00000000-0000-4000-8000-000000000000", "provider:once"), false);
  assert.equal(reviews.answer(first.id, "allow_once"), false);
  assert.ok(reviews.current());
  assert.equal(reviews.answer(first.id, "provider:once"), true);
  assert.equal(await waiting, "provider:once");
  const next = reviews.ask(request);
  assert.equal(reviews.answer(first.id, "provider:always"), false);
  assert.equal(reviews.answer(reviews.current()?.id ?? "", null), true);
  assert.equal(await next, undefined);
  assert.equal(reviews.current(), undefined);
});

test("review expiry, caller abort and window close cancel without applying queued answers", async () => {
  const reviews = new DesktopReviews(() => {}, 20);
  assert.equal(await reviews.ask(request), undefined);
  const abort = new AbortController();
  const first = reviews.ask(request, abort.signal);
  const second = reviews.ask(request);
  const firstId = reviews.current()?.id ?? "";
  abort.abort();
  assert.equal(await first, undefined);
  assert.notEqual(reviews.current()?.id ?? "", firstId);
  assert.equal(reviews.answer(firstId, "provider:always"), false);
  reviews.cancelAll();
  assert.equal(await second, undefined);
  const third = reviews.ask(request);
  reviews.close();
  assert.equal(await third, undefined);
  assert.equal(await reviews.ask(request), undefined);
});

test("reviews snapshot private choices defensively, reject duplicate IDs and bound the queue", async () => {
  const reviews = new DesktopReviews(() => {});
  const changed = structuredClone(request);
  const first = reviews.ask(changed);
  if (changed.kind === "permission") {
    assert.ok(changed.permission.options[0]);
    changed.permission.options[0].optionId = "changed";
  }
  const view = reviews.current();
  assert.ok(view);
  if (view.kind === "permission") {
    assert.ok(view.permission.options[0]);
    view.permission.options[0].optionId = "also-changed";
  }
  assert.equal(reviews.answer(view.id, "changed"), false);
  assert.equal(reviews.answer(view.id, "also-changed"), false);
  assert.equal(reviews.answer(view.id, "provider:once"), true);
  assert.equal(await first, "provider:once");
  const duplicate = structuredClone(request);
  if (duplicate.kind === "permission") {
    assert.ok(duplicate.permission.options[1]);
    duplicate.permission.options[1].optionId = "provider:once";
  }
  assert.equal(await reviews.ask(duplicate), undefined);
  const pending = Array.from({ length: 8 }, () => reviews.ask(request));
  assert.equal(await reviews.ask(request), undefined);
  reviews.close();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(undefined));
});

test("only the bounded private review-answer command is accepted", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    parseDesktopCommand({ type: "review_answer", reviewId: id, choice: null }).type,
    "review_answer",
  );
  assert.throws(() =>
    parseDesktopCommand({ type: "review_answer", reviewId: id, choice: "x".repeat(513) }),
  );
  assert.throws(() =>
    parseDesktopCommand({
      type: "review_answer",
      reviewId: id,
      choice: "yes",
      permission: request,
    }),
  );
});

test("closing a window never presents another queued review during cancellation", async () => {
  const seen: (string | undefined)[] = [];
  const reviews = new DesktopReviews(() => seen.push(reviews.current()?.id));
  const pending = [reviews.ask(request), reviews.ask(request)];
  seen.length = 0;
  reviews.cancelAll();
  assert.deepEqual(await Promise.all(pending), [undefined, undefined]);
  assert.deepEqual(seen, [undefined]);
});
