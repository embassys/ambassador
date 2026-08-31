import assert from "node:assert/strict";
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

function collectStringLeaves(value: unknown, leaves: string[] = []): string[] {
  if (typeof value === "string") leaves.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, leaves);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStringLeaves(item, leaves);
  }
  return leaves;
}

function agentMessage(
  text: string,
  phase: "commentary" | "final_answer" | null = "final_answer",
  id = "cx02_agent_item",
): Readonly<Record<string, unknown>> {
  return { id, type: "agentMessage", phase, text };
}

function threadStarted(cwd: string): Readonly<Record<string, unknown>> {
  return { method: "thread/started", params: { thread: validThread(cwd) } };
}

function turnStarted(turnId = CX02_TURN_ID): Readonly<Record<string, unknown>> {
  return {
    method: "turn/started",
    params: { threadId: CX02_THREAD_ID, turn: validTurn(turnId) },
  };
}

function turnCompleted(
  status: "completed" | "interrupted" | "failed",
  items: readonly Readonly<Record<string, unknown>>[],
  options: { threadId?: string; turnId?: string; itemsView?: string } = {},
): Readonly<Record<string, unknown>> {
  return {
    method: "turn/completed",
    params: {
      threadId: options.threadId ?? CX02_THREAD_ID,
      turn: {
        ...validTurn(options.turnId ?? CX02_TURN_ID, status, items),
        itemsView: options.itemsView ?? "full",
      },
    },
  };
}

type SupportedApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

function approvalParams(
  method: SupportedApprovalMethod,
  cwd: string,
  itemId: string,
  reason: string,
): Readonly<Record<string, unknown>> {
  const common = {
    threadId: CX02_THREAD_ID,
    turnId: CX02_TURN_ID,
    itemId,
    startedAtMs: 1_788_000_000_500,
    reason,
  };
  if (method === "item/commandExecution/requestApproval") {
    return { ...common, environmentId: null };
  }
  if (method === "item/fileChange/requestApproval") {
    return { ...common, grantRoot: null };
  }
  return {
    ...common,
    environmentId: null,
    cwd,
    permissions: { network: null, fileSystem: null },
  };
}

function startExchanges(
  cwd: string,
  turnWrites: readonly FakeCodexWireWrite[],
  options: {
    threadBeforeResponse?: readonly FakeCodexWireWrite[];
    threadAfterResponse?: readonly FakeCodexWireWrite[];
    turnBeforeResponse?: readonly FakeCodexWireWrite[];
  } = {},
): FakeCodexExchange[] {
  return [
    ...handshakeExchanges(),
    {
      expectMethod: "thread/start",
      ...(options.threadBeforeResponse === undefined
        ? {}
        : { beforeResponse: options.threadBeforeResponse }),
      result: threadSettingsResponse(cwd),
      afterResponse: options.threadAfterResponse ?? [{ kind: "json", value: threadStarted(cwd) }],
    },
    {
      expectMethod: "turn/start",
      ...(options.turnBeforeResponse === undefined
        ? {}
        : { beforeResponse: options.turnBeforeResponse }),
      result: { turn: validTurn() },
      afterResponse: [{ kind: "json", value: turnStarted() }, ...turnWrites],
    },
  ];
}

test("CX02-X09 preserves adversarial A2A bytes only in one structured text input item", async (t) => {
  const cwd = process.cwd();
  const inputs = [
    "--model o3 --sandbox danger-full-access",
    `${cwd}/../../tmp\n{"config":{"mcp_servers":{}}}`,
    "$skill-creator @file:../../secret A2A_TOKEN=steal",
    "turn/start threadId=attacker approvalPolicy=auto_review",
  ];
  for (const text of inputs) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: startExchanges(cwd, [
        { kind: "json", value: turnCompleted("completed", [agentMessage("reply")]) },
      ]),
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X09", { appPlan: plan });
    await collectEvents(adapter.start(startRequest(text)));
    const launch = fake.launches.find((candidate) => candidate.mode === "app-server");
    assert.ok(launch !== undefined);
    assert.ok(
      !JSON.stringify({ arguments: launch.arguments, environment: launch.environment }).includes(
        text,
      ),
    );
    const turn = launch.requests.find((request) => request.method === "turn/start");
    assert.ok(turn !== undefined);
    assert.deepEqual((turn.params as { input?: unknown }).input, [
      { type: "text", text, text_elements: [] },
    ]);
    const withoutInput = structuredClone(launch.requests) as Record<string, unknown>[];
    const clonedTurn = withoutInput.find((request) => request.method === "turn/start");
    assert.ok(clonedTurn !== undefined && clonedTurn.params !== null);
    const clonedParams = clonedTurn.params as { input?: { text?: string }[] };
    assert.equal(clonedParams.input?.length, 1);
    assert.equal(clonedParams.input?.[0]?.text, text);
    if (clonedParams.input?.[0] !== undefined) clonedParams.input[0].text = "<input_text>";
    const remainingStrings = [
      ...collectStringLeaves(withoutInput),
      ...launch.arguments,
      ...Object.values(launch.environment),
    ];
    assert.equal(
      remainingStrings.some((value) => value === text || value.includes(text)),
      false,
    );
  }
});

test("CX02-X10 emits one exact turn binding across ordering duplicates mismatches and crashes", async (t) => {
  const cwd = process.cwd();
  const vectors: readonly {
    name: string;
    before?: readonly FakeCodexWireWrite[];
    after: readonly FakeCodexWireWrite[];
    valid: boolean;
    expectedBindings?: number;
  }[] = [
    {
      name: "response then notification",
      after: [
        { kind: "json", value: turnStarted() },
        { kind: "json", value: turnCompleted("completed", [agentMessage("reply")]) },
      ],
      valid: true,
    },
    {
      name: "notification then response",
      before: [{ kind: "json", value: turnStarted() }],
      after: [{ kind: "json", value: turnCompleted("completed", [agentMessage("reply")]) }],
      valid: true,
    },
    {
      name: "matching duplicate",
      before: [{ kind: "json", value: turnStarted() }],
      after: [
        { kind: "json", value: turnStarted() },
        { kind: "json", value: turnCompleted("completed", [agentMessage("reply")]) },
      ],
      valid: true,
    },
    {
      name: "mismatched duplicate",
      before: [{ kind: "json", value: turnStarted() }],
      after: [{ kind: "json", value: turnStarted("different_turn") }],
      valid: false,
      expectedBindings: 1,
    },
    {
      name: "output before binding",
      before: [
        {
          kind: "json",
          value: {
            method: "item/agentMessage/delta",
            params: {
              threadId: CX02_THREAD_ID,
              turnId: CX02_TURN_ID,
              itemId: "item_before_binding",
              delta: "buffer me",
            },
          },
        },
        { kind: "json", value: turnStarted() },
      ],
      after: [{ kind: "json", value: turnCompleted("completed", [agentMessage("buffer me")]) }],
      valid: true,
    },
    { name: "crash before binding", after: [], valid: false },
  ];
  for (const vector of vectors) {
    const exchanges = startExchanges(cwd, vector.after, {
      ...(vector.before === undefined ? {} : { turnBeforeResponse: vector.before }),
    });
    if (vector.name === "crash before binding") {
      exchanges[3] = { expectMethod: "turn/start", exitCodeAfter: 86 };
    }
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X10", {
      appPlan: { kind: "app-server", exchanges },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(
      events.filter((event) => eventName(event) === "turn_bound").length,
      vector.expectedBindings ?? (vector.valid ? 1 : 0),
    );
    assert.equal(eventName(events.at(-1)), vector.valid ? "reply" : "uncertain", vector.name);
    assert.equal(
      fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/start").length,
      1,
    );
    if (vector.name === "output before binding") {
      const bindingIndex = events.findIndex((event) => eventName(event) === "turn_bound");
      const progressIndex = events.findIndex((event) => eventName(event) === "progress");
      assert.ok(bindingIndex >= 0 && progressIndex > bindingIndex);
    }
  }
});

test("CX02-X11 treats deltas as progress and the corroborated full terminal snapshot as authoritative", async (t) => {
  const cwd = process.cwd();
  const item = agentMessage("exact final", "final_answer", "item_final");
  const writes: FakeCodexWireWrite[] = [
    {
      kind: "json",
      value: {
        method: "item/agentMessage/delta",
        params: {
          threadId: CX02_THREAD_ID,
          turnId: CX02_TURN_ID,
          itemId: "item_final",
          delta: "exact ",
        },
      },
    },
    {
      kind: "json",
      value: {
        method: "item/agentMessage/delta",
        params: {
          threadId: CX02_THREAD_ID,
          turnId: CX02_TURN_ID,
          itemId: "item_final",
          delta: "final",
        },
      },
    },
    {
      kind: "json",
      value: {
        method: "item/completed",
        params: {
          threadId: CX02_THREAD_ID,
          turnId: CX02_TURN_ID,
          completedAtMs: 1_788_000_001_000,
          item,
        },
      },
    },
    { kind: "json", value: turnCompleted("completed", [item]) },
  ];
  const { adapter } = await createCx02Adapter(t, "CX02-CX03:X11", {
    appPlan: { kind: "app-server", exchanges: startExchanges(cwd, writes) },
  });
  assert.deepEqual(await collectEvents(adapter.start(startRequest())), [
    {
      event: "session_bound",
      execution_id: CX02_EXECUTION_ID,
      provider_session_id: CX02_THREAD_ID,
    },
    { event: "turn_bound", execution_id: CX02_EXECUTION_ID, provider_turn_id: CX02_TURN_ID },
    { event: "progress", execution_id: CX02_EXECUTION_ID, text: "exact " },
    { event: "progress", execution_id: CX02_EXECUTION_ID, text: "final" },
    { event: "reply", execution_id: CX02_EXECUTION_ID, text: "exact final" },
  ]);

  for (const vector of [
    {
      name: "completed item mismatch",
      writes: [
        {
          kind: "json" as const,
          value: {
            method: "item/completed",
            params: {
              threadId: CX02_THREAD_ID,
              turnId: CX02_TURN_ID,
              completedAtMs: 1_788_000_001_000,
              item: agentMessage("different", "final_answer", "item_final"),
            },
          },
        },
        { kind: "json" as const, value: turnCompleted("completed", [item]) },
      ],
    },
    {
      name: "delta mismatch",
      writes: [
        {
          kind: "json" as const,
          value: {
            method: "item/agentMessage/delta",
            params: {
              threadId: CX02_THREAD_ID,
              turnId: CX02_TURN_ID,
              itemId: "item_final",
              delta: "different",
            },
          },
        },
        {
          kind: "json" as const,
          value: {
            method: "item/completed",
            params: {
              threadId: CX02_THREAD_ID,
              turnId: CX02_TURN_ID,
              completedAtMs: 1_788_000_001_000,
              item,
            },
          },
        },
        { kind: "json" as const, value: turnCompleted("completed", [item]) },
      ],
    },
  ]) {
    const mismatch = await createCx02Adapter(t, "CX02-CX03:X11", {
      appPlan: { kind: "app-server", exchanges: startExchanges(cwd, vector.writes) },
    });
    assert.deepEqual(
      (await collectEvents(mismatch.adapter.start(startRequest()))).at(-1),
      {
        event: "failed",
        execution_id: CX02_EXECUTION_ID,
        reason_code: "provider_result_invalid",
      },
      vector.name,
    );
  }

  const stableOpaqueItemTypes = [
    "userMessage",
    "hookPrompt",
    "plan",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
  ] as const;
  const opaqueItems = stableOpaqueItemTypes.map((type, index) => ({
    id: `opaque_item_${index}`,
    type,
    providerOwnedDetail: { ignored: true },
  }));
  const opaqueCompleted = await createCx02Adapter(t, "CX02-CX03:X11", {
    appPlan: {
      kind: "app-server",
      exchanges: startExchanges(cwd, [
        ...opaqueItems.map((opaqueItem, index) => ({
          kind: "json" as const,
          value: {
            method: "item/completed",
            params: {
              threadId: CX02_THREAD_ID,
              turnId: CX02_TURN_ID,
              completedAtMs: 1_788_000_001_000 + index,
              item: opaqueItem,
            },
          },
        })),
        { kind: "json", value: turnCompleted("completed", [item]) },
      ]),
    },
  });
  assert.equal(
    eventName((await collectEvents(opaqueCompleted.adapter.start(startRequest()))).at(-1)),
    "reply",
    "stable non-agent completed items remain opaque",
  );

  for (const malformedItem of [
    { id: "malformed_agent_type", type: "agentMessage", phase: "final_answer", text: 7 },
    {
      id: "malformed_agent_phase",
      type: "agentMessage",
      phase: "future_phase",
      text: "not authoritative",
    },
    {
      id: "malformed_agent_unknown",
      type: "agentMessage",
      phase: "final_answer",
      text: "not authoritative",
      unknown: true,
    },
    {
      id: "over_limit_completed_agent",
      type: "agentMessage",
      phase: "final_answer",
      text: "x".repeat(262_145),
    },
    { id: "unsupported_dynamic", type: "dynamicToolCall", providerOwnedDetail: true },
  ]) {
    const malformed = await createCx02Adapter(t, "CX02-CX03:X11", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          {
            kind: "json",
            value: {
              method: "item/completed",
              params: {
                threadId: CX02_THREAD_ID,
                turnId: CX02_TURN_ID,
                completedAtMs: 1_788_000_001_000,
                item: malformedItem,
              },
            },
          },
          { kind: "json", value: turnCompleted("completed", [item]) },
        ]),
      },
    });
    assert.equal(
      eventName((await collectEvents(malformed.adapter.start(startRequest()))).at(-1)),
      "uncertain",
      String(malformedItem.id),
    );
  }

  const ignoredNotificationGroups = [
    {
      name: "status and usage",
      methods: [
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "account/rateLimits/updated",
        "mcpServer/startupStatus/updated",
      ],
    },
    {
      name: "hook and tool detail",
      methods: [
        "hook/started",
        "hook/completed",
        "item/started",
        "item/commandExecution/outputDelta",
        "item/commandExecution/terminalInteraction",
        "item/fileChange/outputDelta",
        "item/fileChange/patchUpdated",
        "item/mcpToolCall/progress",
      ],
    },
    {
      name: "plan diff and reasoning",
      methods: [
        "turn/diff/updated",
        "turn/plan/updated",
        "item/plan/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta",
      ],
    },
    {
      name: "non-config warnings",
      methods: ["warning", "guardianWarning", "deprecationNotice", "windows/worldWritableWarning"],
    },
  ] as const;
  for (const group of ignoredNotificationGroups) {
    const accepted = await createCx02Adapter(t, "CX02-CX03:X11", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          ...group.methods.map((method) => ({
            kind: "json" as const,
            value: {
              method,
              params: {
                threadId: CX02_THREAD_ID,
                turnId: CX02_TURN_ID,
                providerOwnedDetail: { ignored: true },
              },
            },
          })),
          { kind: "json", value: turnCompleted("completed", [item]) },
        ]),
      },
    });
    assert.equal(
      eventName((await collectEvents(accepted.adapter.start(startRequest()))).at(-1)),
      "reply",
      `${group.name} accepted`,
    );

    for (const mismatch of [
      { threadId: "different_thread", turnId: CX02_TURN_ID },
      { threadId: CX02_THREAD_ID, turnId: "different_turn" },
    ]) {
      const rejected = await createCx02Adapter(t, "CX02-CX03:X11", {
        appPlan: {
          kind: "app-server",
          exchanges: startExchanges(cwd, [
            {
              kind: "json",
              value: {
                method: group.methods[0],
                params: { ...mismatch, providerOwnedDetail: true },
              },
            },
          ]),
        },
      });
      assert.equal(
        eventName((await collectEvents(rejected.adapter.start(startRequest()))).at(-1)),
        "uncertain",
        `${group.name} mismatched context`,
      );
    }
  }

  const preBinding = await createCx02Adapter(t, "CX02-CX03:X11", {
    appPlan: {
      kind: "app-server",
      exchanges: startExchanges(
        cwd,
        [{ kind: "json", value: turnCompleted("completed", [item]) }],
        {
          turnBeforeResponse: [
            {
              kind: "json",
              value: {
                method: "item/started",
                params: {
                  threadId: CX02_THREAD_ID,
                  turnId: CX02_TURN_ID,
                  providerOwnedDetail: true,
                },
              },
            },
          ],
        },
      ),
    },
  });
  assert.equal(
    eventName((await collectEvents(preBinding.adapter.start(startRequest()))).at(-1)),
    "reply",
    "turn-scoped ignored notification before binding",
  );
});

test("CX02-X12 selects one final_answer before phase-null and rejects remaining ambiguities", async (t) => {
  const cwd = process.cwd();
  const cases: readonly {
    name: string;
    items: readonly Readonly<Record<string, unknown>>[];
    reply?: string;
  }[] = [
    { name: "commentary only", items: [agentMessage("commentary", "commentary")] },
    { name: "one final", items: [agentMessage("final")], reply: "final" },
    { name: "phase-null compatibility", items: [agentMessage("legacy", null)], reply: "legacy" },
    { name: "empty final", items: [agentMessage("")] },
    {
      name: "multiple finals",
      items: [
        agentMessage("one", "final_answer", "one"),
        agentMessage("two", "final_answer", "two"),
      ],
    },
    {
      name: "final plus phase-null",
      items: [agentMessage("one"), agentMessage("legacy", null, "two")],
      reply: "one",
    },
    {
      name: "malformed",
      items: [{ id: "bad", type: "agentMessage", phase: "final_answer", text: 1 }],
    },
    { name: "invalid Unicode", items: [agentMessage("\ud800")] },
    { name: "one over", items: [agentMessage("x".repeat(262_145))] },
  ];
  for (const vector of cases) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X12", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          { kind: "json", value: turnCompleted("completed", vector.items) },
        ]),
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.deepEqual(
      events.at(-1),
      vector.reply === undefined
        ? {
            event: "failed",
            execution_id: CX02_EXECUTION_ID,
            reason_code: "provider_result_invalid",
          }
        : { event: "reply", execution_id: CX02_EXECUTION_ID, text: vector.reply },
      vector.name,
    );
  }
});

test("CX02-X13 maps only an exact failed turn definitely and every executed unknown to uncertainty", async (t) => {
  const cwd = process.cwd();
  const vectors: readonly {
    name: string;
    writes: readonly FakeCodexWireWrite[];
    exchangeOverride?: FakeCodexExchange;
    reason: "provider_execution_failed" | "provider_outcome_unknown";
    event: "failed" | "uncertain";
  }[] = [
    {
      name: "failed",
      writes: [{ kind: "json", value: turnCompleted("failed", []) }],
      event: "failed",
      reason: "provider_execution_failed",
    },
    {
      name: "interrupted",
      writes: [{ kind: "json", value: turnCompleted("interrupted", []) }],
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      name: "EOF",
      writes: [],
      exchangeOverride: {
        expectMethod: "turn/start",
        result: { turn: validTurn() },
        afterResponse: [{ kind: "json", value: turnStarted() }],
        exitCodeAfter: 0,
      },
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      name: "process crash",
      writes: [],
      exchangeOverride: { expectMethod: "turn/start", exitCodeAfter: 87 },
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      name: "JSON-RPC error",
      writes: [],
      exchangeOverride: {
        expectMethod: "turn/start",
        error: { code: -32_000, message: "provider error" },
      },
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      name: "failed turn with malformed scalar item",
      writes: [
        {
          kind: "json",
          value: turnCompleted("failed", [42 as unknown as Readonly<Record<string, unknown>>]),
        },
      ],
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      name: "failed turn with malformed agent item",
      writes: [
        {
          kind: "json",
          value: turnCompleted("failed", [
            {
              id: "malformed_failed_agent",
              type: "agentMessage",
              phase: "final_answer",
              text: 7,
            },
          ]),
        },
      ],
      event: "uncertain",
      reason: "provider_outcome_unknown",
    },
  ];
  for (const vector of vectors) {
    const exchanges = startExchanges(cwd, vector.writes);
    if (vector.exchangeOverride !== undefined) exchanges[3] = vector.exchangeOverride;
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X13", {
      appPlan: { kind: "app-server", exchanges },
    });
    const terminal = (await collectEvents(adapter.start(startRequest()))).at(-1);
    assert.deepEqual(terminal, {
      event: vector.event,
      execution_id: CX02_EXECUTION_ID,
      reason_code: vector.reason,
    });
  }

  const deadlineClock = new ManualK02Clock(CX02_DEADLINE_MS - 1);
  const noTerminal = await createCx02Adapter(t, "CX02-CX03:X13", {
    clock: deadlineClock,
    appPlan: { kind: "app-server", exchanges: startExchanges(cwd, []) },
  });
  const pending = collectEvents(noTerminal.adapter.start(startRequest()));
  await noTerminal.fake.waitForRequests(4);
  deadlineClock.advance(1);
  assert.deepEqual((await pending).at(-1), {
    event: "uncertain",
    execution_id: CX02_EXECUTION_ID,
    reason_code: "provider_outcome_unknown",
  });
});

test("CX02-X14 normalizes only three supported approval requests and sends no response or grant", async (t) => {
  const cwd = process.cwd();
  const methods: readonly SupportedApprovalMethod[] = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ];
  const ids = [42, "approval-wire-id"] as const;
  for (const method of methods) {
    for (const id of ids) {
      const approval = {
        id,
        method,
        params: approvalParams(method, cwd, "approval_item", "fixture detail must stay private"),
      };
      const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X14", {
        appPlan: {
          kind: "app-server",
          exchanges: startExchanges(cwd, [{ kind: "json", value: approval }]),
          onStdinEnd: "exit",
        },
      });
      const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
      assert.equal(eventName((await iterator.next()).value), "session_bound");
      assert.equal(eventName((await iterator.next()).value), "turn_bound");
      assert.deepEqual((await iterator.next()).value, {
        event: "approval_required",
        execution_id: CX02_EXECUTION_ID,
        approval_request_id: typeof id === "number" ? `n:${id}` : `s:${id}`,
      });
      assert.equal(fake.launches.at(-1)?.requests.length, 4);
      assert.ok(!JSON.stringify(fake.launches).includes("fixture detail must stay private"));
      await adapter.cancel(cancelRequest());
      await iterator.return?.();
    }
  }

  const malformedApprovals: readonly {
    name: string;
    method: SupportedApprovalMethod;
    params: Readonly<Record<string, unknown>>;
  }[] = [
    {
      name: "unknown command field",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        unknown: true,
      },
    },
    {
      name: "malformed command actions",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        commandActions: {},
      },
    },
    {
      name: "malformed command action element",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        commandActions: [{ type: "read", command: "cat", name: 7, path: cwd }],
      },
    },
    {
      name: "unknown network approval context field",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        networkApprovalContext: { host: "example.com", protocol: "https", unknown: true },
      },
    },
    {
      name: "future network approval protocol",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams(
          "item/commandExecution/requestApproval",
          cwd,
          "approval_item",
          "private",
        ),
        networkApprovalContext: { host: "example.com", protocol: "future" },
      },
    },
    {
      name: "malformed exec policy amendment",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        proposedExecpolicyAmendment: { command: "allow" },
      },
    },
    {
      name: "malformed network policy amendment",
      method: "item/commandExecution/requestApproval",
      params: {
        ...approvalParams("item/commandExecution/requestApproval", cwd, "approval_item", "private"),
        proposedNetworkPolicyAmendments: [{ host: "example.com", action: "future" }],
      },
    },
    {
      name: "missing file timestamp",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: CX02_THREAD_ID,
        turnId: CX02_TURN_ID,
        itemId: "approval_item",
        reason: "private",
        grantRoot: null,
      },
    },
    {
      name: "malformed file grant root",
      method: "item/fileChange/requestApproval",
      params: {
        ...approvalParams("item/fileChange/requestApproval", cwd, "approval_item", "private"),
        grantRoot: 7,
      },
    },
    {
      name: "malformed permission network flag",
      method: "item/permissions/requestApproval",
      params: {
        ...approvalParams("item/permissions/requestApproval", cwd, "approval_item", "private"),
        permissions: { network: { enabled: "yes" }, fileSystem: null },
      },
    },
    {
      name: "unknown nested permission field",
      method: "item/permissions/requestApproval",
      params: {
        ...approvalParams("item/permissions/requestApproval", cwd, "approval_item", "private"),
        permissions: { network: { enabled: null, unknown: true }, fileSystem: null },
      },
    },
    {
      name: "malformed permission entry",
      method: "item/permissions/requestApproval",
      params: {
        ...approvalParams("item/permissions/requestApproval", cwd, "approval_item", "private"),
        permissions: {
          network: null,
          fileSystem: {
            read: [cwd],
            write: null,
            entries: [
              {
                path: { type: "special", value: { kind: "root", unknown: true } },
                access: "read",
              },
            ],
          },
        },
      },
    },
  ];
  for (const vector of malformedApprovals) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X14", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          { kind: "json", value: { id: 42, method: vector.method, params: vector.params } },
          {
            kind: "json",
            value: turnCompleted("completed", [agentMessage("must not be observed")]),
          },
        ]),
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(
      events.some((event) => eventName(event) === "approval_required"),
      false,
      vector.name,
    );
    assert.equal(eventName(events.at(-1)), "uncertain", vector.name);
  }
});

test("CX02-X15 never invents approval resolution and rejects every unsupported server control", async (t) => {
  const cwd = process.cwd();
  const unsupported = [
    "mcpServer/elicitation/request",
    "item/tool/requestUserInput",
    "item/dynamicTool/call",
    "account/chatgptAuthTokens/refresh",
    "requestAttestation",
    "execCommandApproval",
    "applyPatchApproval",
  ];
  for (const method of unsupported) {
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X15", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          {
            kind: "json",
            value: {
              id: 77,
              method,
              params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID, detail: "private" },
            },
          },
        ]),
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain");
    assert.equal(
      events.some((event) => eventName(event) === "approval_resolved"),
      false,
    );
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.id === 77),
      false,
    );
  }

  for (const method of [
    "account/updated",
    "thread/settings/updated",
    "serverRequest/resolved",
    "configWarning",
  ]) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X15", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          {
            kind: "json",
            value: {
              method,
              params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID },
            },
          },
        ]),
      },
    });
    assert.equal(
      eventName((await collectEvents(adapter.start(startRequest()))).at(-1)),
      "uncertain",
      `${method} notification remains rejected`,
    );
  }

  const approval = {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: approvalParams(
      "item/commandExecution/requestApproval",
      cwd,
      "pending_approval",
      "private pending detail",
    ),
  };
  for (const vector of [
    {
      name: "matching resolution without decision",
      resolutions: [
        { method: "serverRequest/resolved", params: { threadId: CX02_THREAD_ID, requestId: 42 } },
      ],
    },
    {
      name: "repeated resolution",
      resolutions: [
        { method: "serverRequest/resolved", params: { threadId: CX02_THREAD_ID, requestId: 42 } },
        { method: "serverRequest/resolved", params: { threadId: CX02_THREAD_ID, requestId: 42 } },
      ],
    },
    {
      name: "mismatched resolution",
      resolutions: [
        { method: "serverRequest/resolved", params: { threadId: CX02_THREAD_ID, requestId: 43 } },
      ],
    },
  ]) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X15", {
      appPlan: {
        kind: "app-server",
        exchanges: startExchanges(cwd, [
          { kind: "json", value: approval },
          ...vector.resolutions.map((value) => ({ kind: "json" as const, value })),
        ]),
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(
      events.some((event) => eventName(event) === "approval_required"),
      true,
      vector.name,
    );
    assert.equal(
      events.some((event) => eventName(event) === "approval_resolved"),
      false,
      vector.name,
    );
    assert.equal(eventName(events.at(-1)), "uncertain", vector.name);
  }
});
