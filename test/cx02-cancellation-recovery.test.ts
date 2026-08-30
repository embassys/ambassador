import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import {
  CX02_DEADLINE_MS,
  CX02_EXECUTION_ID,
  CX02_THREAD_ID,
  CX02_TURN_ID,
  cancelRequest,
  collectEvents,
  createCx02Adapter,
  type FakeCodexExchange,
  type FakeCodexProcessPlan,
  type FakeCodexWireWrite,
  handshakeExchanges,
  recoverRequest,
  startRequest,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";
import { ManualK02Clock } from "./support/connector/k02-production.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function threadStarted(cwd: string): Readonly<Record<string, unknown>> {
  return { method: "thread/started", params: { thread: validThread(cwd) } };
}

function turnStarted(): Readonly<Record<string, unknown>> {
  return {
    method: "turn/started",
    params: { threadId: CX02_THREAD_ID, turn: validTurn() },
  };
}

function completedTurn(
  status: "completed" | "failed" | "interrupted" | "inProgress",
  text?: string,
  id = CX02_TURN_ID,
): Readonly<Record<string, unknown>> {
  return validTurn(
    id,
    status,
    text === undefined
      ? []
      : [{ id: `item_${id}`, type: "agentMessage", phase: "final_answer", text }],
  );
}

function turnCompleted(status: "completed" | "failed" | "interrupted", text?: string): unknown {
  return {
    method: "turn/completed",
    params: { threadId: CX02_THREAD_ID, turn: completedTurn(status, text) },
  };
}

function activeStartExchanges(
  cwd: string,
  deferred: readonly FakeCodexWireWrite[],
  additional: readonly FakeCodexExchange[] = [],
): FakeCodexExchange[] {
  return [
    ...handshakeExchanges(),
    {
      expectMethod: "thread/start",
      result: threadSettingsResponse(cwd),
      afterResponse: [{ kind: "json", value: threadStarted(cwd) }],
    },
    {
      expectMethod: "turn/start",
      result: { turn: validTurn() },
      afterResponse: [{ kind: "json", value: turnStarted() }, ...deferred],
      allowConcurrentAfterResponse: true,
    },
    ...additional,
  ];
}

test("CX02-X16 interrupts only a bound exact turn and never extends cancellation grace", async (t) => {
  const cwd = process.cwd();
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X16", {
    appPlan: {
      kind: "app-server",
      exchanges: activeStartExchanges(
        cwd,
        [{ kind: "json", value: turnCompleted("interrupted"), gate: "after_interrupt" }],
        [
          {
            expectMethod: "turn/interrupt",
            expectRequest: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID },
            },
            result: {},
          },
        ],
      ),
    },
  });
  const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
  assert.equal(eventName((await iterator.next()).value), "session_bound");
  assert.equal(eventName((await iterator.next()).value), "turn_bound");
  const pendingTerminal = iterator.next();
  assert.deepEqual(await adapter.cancel(cancelRequest()), { status: "cancel_requested" });
  await fake.waitForRequests(5);
  fake.release("after_interrupt");
  assert.equal(eventName((await pendingTerminal).value), "uncertain");
  assert.equal(
    fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/interrupt").length,
    1,
  );

  const unbound = await createCx02Adapter(t, "CX02-CX03:X16", {
    appPlan: { kind: "app-server", exchanges: activeStartExchanges(cwd, []) },
  });
  assert.deepEqual(await unbound.adapter.cancel(cancelRequest(null)), { status: "not_found" });
  assert.equal(unbound.fake.launches.filter((launch) => launch.mode === "app-server").length, 0);

  const preTurn = await createCx02Adapter(t, "CX02-CX03:X16", {
    appPlan: { kind: "app-server", exchanges: activeStartExchanges(cwd, []) },
  });
  const preTurnIterator = preTurn.adapter.start(startRequest())[Symbol.asyncIterator]();
  assert.equal(eventName((await preTurnIterator.next()).value), "session_bound");
  assert.deepEqual(await preTurn.adapter.cancel(cancelRequest()), { status: "not_found" });
  assert.equal(
    preTurn.fake.launches.at(-1)?.requests.some((request) => request.method === "turn/interrupt"),
    false,
  );
  await preTurnIterator.return?.();

  const approvalRequest = {
    id: "approval_waiting",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: CX02_THREAD_ID,
      turnId: CX02_TURN_ID,
      itemId: "approval_item",
      reason: "private",
    },
  };
  const waiting = await createCx02Adapter(t, "CX02-CX03:X16", {
    appPlan: {
      kind: "app-server",
      exchanges: activeStartExchanges(
        cwd,
        [
          { kind: "json", value: approvalRequest },
          { kind: "json", value: turnCompleted("interrupted"), gate: "waiting_interrupted" },
        ],
        [
          {
            expectMethod: "turn/interrupt",
            expectRequest: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID },
            },
            result: {},
          },
        ],
      ),
    },
  });
  const waitingIterator = waiting.adapter.start(startRequest())[Symbol.asyncIterator]();
  assert.equal(eventName((await waitingIterator.next()).value), "session_bound");
  assert.equal(eventName((await waitingIterator.next()).value), "turn_bound");
  assert.equal(eventName((await waitingIterator.next()).value), "approval_required");
  const waitingTerminal = waitingIterator.next();
  assert.deepEqual(await waiting.adapter.cancel(cancelRequest()), { status: "cancel_requested" });
  await waiting.fake.waitForRequests(5);
  waiting.fake.release("waiting_interrupted");
  assert.equal(eventName((await waitingTerminal).value), "uncertain");

  const terminal = await createCx02Adapter(t, "CX02-CX03:X16", {
    appPlan: {
      kind: "app-server",
      exchanges: activeStartExchanges(cwd, [
        { kind: "json", value: turnCompleted("completed", "terminal reply") },
      ]),
    },
  });
  assert.equal(
    eventName((await collectEvents(terminal.adapter.start(startRequest()))).at(-1)),
    "reply",
  );
  assert.deepEqual(await terminal.adapter.cancel(cancelRequest()), { status: "already_terminal" });

  for (const vector of [
    {
      name: "malformed interrupt result",
      interrupt: {
        expectMethod: "turn/interrupt",
        result: { unexpected: true },
        exitCodeAfter: 0,
      } satisfies FakeCodexExchange,
    },
    {
      name: "mismatched interrupt response",
      interrupt: {
        expectMethod: "turn/interrupt",
        beforeResponse: [{ kind: "json" as const, value: { id: 99, result: {} } }],
        exitCodeAfter: 0,
      } satisfies FakeCodexExchange,
    },
  ]) {
    const malformed = await createCx02Adapter(t, "CX02-CX03:X16", {
      appPlan: {
        kind: "app-server",
        exchanges: activeStartExchanges(cwd, [], [vector.interrupt]),
      },
    });
    const malformedIterator = malformed.adapter.start(startRequest())[Symbol.asyncIterator]();
    assert.equal(eventName((await malformedIterator.next()).value), "session_bound");
    assert.equal(eventName((await malformedIterator.next()).value), "turn_bound");
    const malformedTerminal = malformedIterator.next();
    assert.deepEqual(await malformed.adapter.cancel(cancelRequest()), {
      status: "cancel_requested",
    });
    assert.equal(eventName((await malformedTerminal).value), "uncertain", vector.name);
  }

  const graceClock = new ManualK02Clock(CX02_DEADLINE_MS - 1);
  let graceFake: Awaited<ReturnType<typeof createCx02Adapter>>["fake"] | undefined;
  let containmentCalls = 0;
  const grace = await createCx02Adapter(t, "CX02-CX03:X16", {
    clock: graceClock,
    containmentForTest: {
      async contain() {
        containmentCalls += 1;
        assert.ok(graceFake !== undefined);
        return await graceFake.containLatestUnit();
      },
      isEmpty() {
        return graceFake?.isLatestUnitEmpty() ?? false;
      },
    },
    appPlan: {
      kind: "app-server",
      exchanges: activeStartExchanges(
        cwd,
        [],
        [
          {
            expectMethod: "turn/interrupt",
            beforeResponse: [
              {
                kind: "json",
                value: { method: "warning", params: { message: "slow interrupt" } },
                gate: "never_release_interrupt",
              },
            ],
          },
        ],
      ),
    },
  });
  graceFake = grace.fake;
  const graceIterator = grace.adapter.start(startRequest())[Symbol.asyncIterator]();
  assert.equal(eventName((await graceIterator.next()).value), "session_bound");
  assert.equal(eventName((await graceIterator.next()).value), "turn_bound");
  let graceSettled = false;
  const graceTerminal = graceIterator.next().then((result) => {
    graceSettled = true;
    return result;
  });
  graceClock.advance(1);
  assert.deepEqual(await grace.adapter.cancel(cancelRequest()), { status: "cancel_requested" });
  await grace.fake.waitForRequests(5);
  graceClock.advance(9_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(containmentCalls, 0);
  assert.equal(graceSettled, false);
  graceClock.advance(1);
  assert.equal(eventName((await graceTerminal).value), "uncertain");
  assert.equal(containmentCalls, 1);
  assert.equal(
    grace.fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/interrupt")
      .length,
    1,
  );
});

test("CX02-X17 recovers only one exact stored turn and makes every ambiguous thread read uncertain", async (t) => {
  const cwd = process.cwd();
  const exact = completedTurn("completed", "recovered reply");
  const vectors: readonly {
    name: string;
    turns: readonly Readonly<Record<string, unknown>>[];
    terminal: string;
  }[] = [
    { name: "completed", turns: [exact], terminal: "reply" },
    { name: "failed", turns: [completedTurn("failed")], terminal: "failed" },
    { name: "interrupted", turns: [completedTurn("interrupted")], terminal: "uncertain" },
    { name: "in progress", turns: [completedTurn("inProgress")], terminal: "uncertain" },
    { name: "missing", turns: [], terminal: "uncertain" },
    { name: "duplicate", turns: [exact, exact], terminal: "uncertain" },
    {
      name: "wrong turn",
      turns: [completedTurn("completed", "wrong", "wrong_turn")],
      terminal: "uncertain",
    },
  ];
  for (const vector of vectors) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/read",
          expectRequest: {
            id: 2,
            method: "thread/read",
            params: { threadId: CX02_THREAD_ID, includeTurns: true },
          },
          result: { thread: validThread(cwd, CX02_THREAD_ID, vector.turns) },
        },
      ],
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X17", { appPlan: plan });
    const events = await collectEvents(adapter.recover(recoverRequest()));
    assert.equal(eventName(events.at(-1)), vector.terminal, vector.name);
    const requests = fake.launches.at(-1)?.requests ?? [];
    assert.equal(requests.filter((request) => request.method === "thread/read").length, 1);
    assert.equal(
      requests.some((request) => request.method === "turn/start"),
      false,
    );
  }

  const wrongThread = await createCx02Adapter(t, "CX02-CX03:X17", {
    appPlan: {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/read",
          result: { thread: validThread(cwd, "wrong_thread", [exact]) },
        },
      ],
    },
  });
  assert.equal(
    eventName((await collectEvents(wrongThread.adapter.recover(recoverRequest()))).at(-1)),
    "uncertain",
  );
});

test("CX02-X18 makes null-turn recovery uncertain before any App Server request", async (t) => {
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X18", {
    appPlan: { kind: "app-server", exchanges: [] },
  });
  assert.deepEqual(await collectEvents(adapter.recover(recoverRequest(null))), [
    {
      event: "uncertain",
      execution_id: CX02_EXECUTION_ID,
      reason_code: "provider_outcome_unknown",
    },
  ]);
  assert.equal(fake.launches.filter((launch) => launch.mode === "app-server").length, 0);
});

test("CX02-X19 keeps large unrelated history content memory-only while selecting the exact turn", async (t) => {
  const cwd = process.cwd();
  const markers = {
    prompt: "CX02_HISTORY_PROMPT_SECRET",
    reply: "CX02_HISTORY_REPLY_SECRET",
    tool: "CX02_HISTORY_TOOL_SECRET",
    credential: "CX02_HISTORY_CREDENTIAL_SECRET",
    approval: "CX02_HISTORY_APPROVAL_SECRET",
  };
  const unrelated = Array.from({ length: 200 }, (_, index) =>
    completedTurn(
      "completed",
      `${markers.prompt}-${index}-${markers.reply}-${markers.tool}-${markers.credential}-${markers.approval}`,
      `unrelated_turn_${index}`,
    ),
  );
  const exact = completedTurn("completed", "bounded recovered reply");
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X19", {
    appPlan: {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/read",
          result: { thread: validThread(cwd, CX02_THREAD_ID, [...unrelated, exact]) },
        },
      ],
    },
  });
  assert.deepEqual((await collectEvents(adapter.recover(recoverRequest()))).at(-1), {
    event: "reply",
    execution_id: CX02_EXECUTION_ID,
    text: "bounded recovered reply",
  });
  const launch = fake.launches.at(-1);
  assert.ok(launch !== undefined);
  assert.ok(
    !JSON.stringify({ arguments: launch.arguments, environment: launch.environment }).includes(
      markers.prompt,
    ),
  );
  const files = await import("node:fs/promises").then(
    async ({ readdir }) => await readdir(dirname(fake.executablePath)),
  );
  assert.deepEqual(
    files.sort(),
    ["codex", "codex.control.sock", "provider-config-sentinel"].sort(),
  );
});
