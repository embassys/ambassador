import assert from "node:assert/strict";
import { test } from "node:test";
import { SetupApprovalGuard } from "../src/desktop/setup-approval.js";

test("setup approvals preserve exact option IDs and reject unrelated or stale replies", async () => {
  const sent: { requestId: string }[] = [];
  const guard = new SetupApprovalGuard((value) => {
    if (value.type === "setup_approval") sent.push(value);
  });
  const controller = new AbortController();
  const task = guard.ask(
    {
      title: "Embassys connection check",
      detail: "Read enrollment",
      options: [{ optionId: "opaque:yes", name: "Only this call", kind: "allow_once" }],
    },
    controller.signal,
  );
  const id = sent[0]?.requestId;
  assert.ok(id);
  guard.receive({
    protocol: 1,
    type: "setup_approval_result",
    requestId: "00000000-0000-4000-8000-000000000000",
    optionId: "opaque:yes",
  });
  guard.receive({
    protocol: 1,
    type: "setup_approval_result",
    requestId: id,
    optionId: "opaque:yes",
  });
  assert.equal(await task, "opaque:yes");
  const next = guard.ask(
    {
      title: "Read",
      detail: "",
      options: [{ optionId: "another", name: "Allow", kind: "allow_once" }],
    },
    controller.signal,
  );
  guard.receive({
    protocol: 1,
    type: "setup_approval_result",
    requestId: sent[1]?.requestId,
    optionId: "opaque:yes",
  });
  assert.equal(await next, undefined);
  guard.close();
});

test("setup approval cancels on timeout, shutdown and caller abort", async () => {
  const request = {
    title: "Read",
    detail: "",
    options: [{ optionId: "once", name: "Yes", kind: "allow_once" as const }],
  };
  const guard = new SetupApprovalGuard(() => {}, 10);
  assert.equal(await guard.ask(request, new AbortController().signal), undefined);
  const abort = new AbortController();
  const task = guard.ask(request, abort.signal);
  abort.abort();
  assert.equal(await task, undefined);
  const task2 = guard.ask(request, new AbortController().signal);
  guard.close();
  assert.equal(await task2, undefined);
});
