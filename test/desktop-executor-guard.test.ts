import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutorGuard, executorCheckSchema } from "../src/desktop/executor-guard.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";

const context = { agent: "claude" as const, workingDirectory: process.cwd() };

test("executor checks require a correlated private parent reply, not a renderer command", async () => {
  const sent: unknown[] = [];
  const guard = new ExecutorGuard((request) => {
    sent.push(request);
  });
  const first = guard.check(context, new AbortController().signal);
  const request = executorCheckSchema.parse(sent[0]);
  assert.throws(() => parseDesktopCommand(request));
  assert.throws(() =>
    executorCheckSchema.parse({ ...request, context: { ...context, agent: "shell" } }),
  );
  assert.equal(
    guard.receive({ protocol: 1, type: "executor_check_result", requestId: "bad", allowed: true }),
    false,
  );
  assert.equal(
    guard.receive({
      protocol: 1,
      type: "executor_check_result",
      requestId: request.requestId,
      allowed: true,
    }),
    true,
  );
  await first;
  const next = guard.check(context, new AbortController().signal);
  const second = executorCheckSchema.parse(sent[1]);
  guard.receive({
    protocol: 1,
    type: "executor_check_result",
    requestId: request.requestId,
    allowed: true,
  });
  guard.receive({
    protocol: 1,
    type: "executor_check_result",
    requestId: second.requestId,
    allowed: false,
  });
  await assert.rejects(next, /connection/);
});

test("missing replies, abort, shutdown and overlapping checks cannot grant delivery", async () => {
  const guard = new ExecutorGuard(() => {}, 10);
  const controller = new AbortController();
  const first = guard.check(context, controller.signal);
  await assert.rejects(guard.check(context, controller.signal));
  controller.abort();
  await assert.rejects(first);
  await assert.rejects(guard.check(context, new AbortController().signal), /connection/);
  const last = guard.check(context, new AbortController().signal);
  guard.close();
  await assert.rejects(last);
  await assert.rejects(guard.check(context, new AbortController().signal));
});
