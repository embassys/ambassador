import assert from "node:assert/strict";
import test from "node:test";

import {
  CL02_EXECUTION_ID,
  CL02_INPUT_UUID,
  CL02_SESSION_ID,
  collectEvents,
  createCl02Adapter,
  createCl02Clock,
  initRecord,
  replayRecord,
  resultRecord,
  startRequest,
} from "./support/claude-code/index.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function assistantRecord(text: string): Readonly<Record<string, unknown>> {
  return {
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000201",
    session_id: CL02_SESSION_ID,
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

function assistantToolRecord(input: unknown): Readonly<Record<string, unknown>> {
  return {
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000202",
    session_id: CL02_SESSION_ID,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "Read", input }],
    },
    parent_tool_use_id: null,
  };
}

function maximumContainerDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + Math.max(0, ...children.map(maximumContainerDepth));
}

function nestedRecordAtDepth(depth: number): Readonly<Record<string, unknown>> {
  let input: unknown = "leaf";
  let record = assistantToolRecord(input);
  while (maximumContainerDepth(record) < depth) {
    input = [input];
    record = assistantToolRecord(input);
  }
  assert.equal(maximumContainerDepth(record), depth);
  return record;
}

function assistantRecordAtBytes(targetBytes: number): Readonly<Record<string, unknown>> {
  const empty = assistantRecord("");
  const padding = targetBytes - Buffer.byteLength(JSON.stringify(empty));
  assert.ok(padding >= 0);
  const record = assistantRecord("x".repeat(padding));
  assert.equal(Buffer.byteLength(JSON.stringify(record)), targetBytes);
  return record;
}

function stdoutBoundaryPlan(targetBytes: number) {
  const init = initRecord(process.cwd());
  const replay = replayRecord("CL02 untrusted input");
  const result = resultRecord("stdout boundary");
  const lineBytes = (record: Readonly<Record<string, unknown>>) =>
    Buffer.byteLength(JSON.stringify(record)) + 1;
  let remaining = targetBytes - lineBytes(init) - lineBytes(replay) - lineBytes(result);
  const assistantWrites: { kind: "json"; value: Readonly<Record<string, unknown>> }[] = [];
  while (remaining > 1_048_577) {
    assistantWrites.push({ kind: "json", value: assistantRecordAtBytes(1_048_576) });
    remaining -= 1_048_577;
  }
  assert.ok(remaining > Buffer.byteLength(JSON.stringify(assistantRecord(""))) + 1);
  assistantWrites.push({ kind: "json", value: assistantRecordAtBytes(remaining - 1) });
  return {
    kind: "turn" as const,
    writesBeforeInput: [{ kind: "json" as const, value: init }],
    writesAfterInput: [
      { kind: "json" as const, value: replay },
      ...assistantWrites,
      { kind: "json" as const, value: result },
    ],
  };
}

function activePlan(
  records: readonly Readonly<Record<string, unknown>>[],
  text = "CL02 untrusted input",
) {
  return {
    kind: "turn" as const,
    writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd()) }],
    writesAfterInput: [
      { kind: "json" as const, value: replayRecord(text) },
      ...records.map((value) => ({ kind: "json" as const, value })),
    ],
  };
}

test("CL02-L09 denies permission and rejects every approval or unsupported control record", async (t) => {
  const records = [
    { type: "permission_denial", detail: "private" },
    { type: "approval_request", detail: "private" },
    { type: "interactive_prompt", detail: "private" },
    { type: "auth_status", detail: "private" },
    { type: "config_changed", detail: "private" },
    { type: "mcp_status", detail: "private" },
    { type: "browser_control", detail: "private" },
    { type: "channel_event", detail: "private" },
    { type: "cloud_event", detail: "private" },
    { type: "remote_control", detail: "private" },
    { type: "agent_event", detail: "private" },
    { type: "task_event", detail: "private" },
    { type: "workflow_event", detail: "private" },
    { type: "system", subtype: "hook_started", detail: "private" },
    { type: "system", subtype: "plugin_install", detail: "private" },
  ];
  for (const record of records) {
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L09", {
      turnPlan: activePlan([record]),
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain");
    assert.ok(!JSON.stringify(events).includes("private"));
    assert.equal(fake.launches.at(-1)?.stdinRecords.length, 1);
  }
});

test("CL02-L10 keeps supported assistant tool retry and status content transient", async (t) => {
  const secret = "CL02_TRANSIENT_PROVIDER_SECRET";
  const records = [
    assistantRecord(secret),
    {
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000202",
      session_id: CL02_SESSION_ID,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: secret }],
      },
      parent_tool_use_id: "tool_1",
    },
    { type: "api_retry", session_id: CL02_SESSION_ID, attempt: 1 },
    { type: "rate_limit_event", session_id: CL02_SESSION_ID, status: "allowed" },
    { type: "status", session_id: CL02_SESSION_ID, status: "running" },
    { type: "compact_boundary", session_id: CL02_SESSION_ID },
    { type: "tool_progress", session_id: CL02_SESSION_ID, tool_use_id: "tool_1" },
    { type: "tool_summary", session_id: CL02_SESSION_ID, tool_use_id: "tool_1" },
    resultRecord("CL02 exact reply"),
  ];
  const { adapter } = await createCl02Adapter(t, "CL02-CL03:L10", {
    turnPlan: activePlan(records),
  });
  const events = await collectEvents(adapter.start(startRequest()));
  assert.deepEqual(events.at(-1), {
    event: "reply",
    execution_id: CL02_EXECUTION_ID,
    text: "CL02 exact reply",
  });
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("CL02-L11 normalizes only one exact terminal result", async (t) => {
  const vectors: readonly {
    readonly name: string;
    readonly records: readonly Readonly<Record<string, unknown>>[];
    readonly terminal: "reply" | "failed" | "uncertain";
  }[] = [
    { name: "success", records: [resultRecord("exact")], terminal: "reply" },
    {
      name: "provider error",
      records: [resultRecord("error", { subtype: "error" })],
      terminal: "failed",
    },
    { name: "empty result", records: [resultRecord("")], terminal: "failed" },
    {
      name: "malformed result",
      records: [{ ...resultRecord("x"), result: 3 }],
      terminal: "failed",
    },
    {
      name: "multiple results",
      records: [resultRecord("one"), resultRecord("two")],
      terminal: "uncertain",
    },
    {
      name: "wrong session",
      records: [resultRecord("x", { sessionId: "wrong" })],
      terminal: "uncertain",
    },
    {
      name: "oversized result",
      records: [resultRecord("x".repeat(262_145))],
      terminal: "failed",
    },
  ];
  for (const vector of vectors) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L11", {
      turnPlan: activePlan(vector.records),
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), vector.terminal, vector.name);
  }
});

test("CL02-L12 separates definite pre-input failure from every post-input unknown", async (t) => {
  const preInputPlans = [
    { kind: "turn" as const, writesBeforeInput: [{ kind: "utf8" as const, value: "not-json\n" }] },
    { kind: "turn" as const, exitBeforeInput: { exitCode: 0 } },
    { kind: "turn" as const, exitBeforeInput: { exitCode: 87 } },
    { kind: "turn" as const, exitBeforeInput: { exitSignal: "SIGKILL" as const } },
    { kind: "turn" as const, stdoutBytesBeforeInput: 8_388_609 },
    { kind: "turn" as const, stderrBytes: 8_388_609 },
  ];
  for (const turnPlan of preInputPlans) {
    const preInput = await createCl02Adapter(t, "CL02-CL03:L12", { turnPlan });
    assert.equal(
      eventName((await collectEvents(preInput.adapter.start(startRequest()))).at(-1)),
      "failed",
    );
    assert.deepEqual(preInput.fake.launches.at(-1)?.stdinRecords, []);
  }

  const preInputClock = createCl02Clock();
  const preInputTimeout = await createCl02Adapter(t, "CL02-CL03:L12", {
    clock: preInputClock,
    turnPlan: { kind: "turn", onStdinEnd: "resist" },
  });
  const preInputTimeoutEvents = collectEvents(preInputTimeout.adapter.start(startRequest()));
  await preInputTimeout.fake.waitForLaunches(2);
  for (
    let attempt = 0;
    attempt < 100 && preInputClock.pendingTimerCountForTest() === 0;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(preInputClock.pendingTimerCountForTest(), 1);
  preInputClock.advance(5_000);
  assert.equal(eventName((await preInputTimeoutEvents).at(-1)), "failed");

  for (const plan of [
    activePlan([]),
    {
      ...activePlan([]),
      writesAfterInput: [
        { kind: "json" as const, value: replayRecord("CL02 untrusted input") },
        { kind: "utf8" as const, value: "{broken\n" },
      ],
      exitCode: 87,
    },
    { ...activePlan([]), stderrBytes: 8_388_609 },
    { ...activePlan([]), stdoutBytesAfterInput: 8_388_609 },
    { ...activePlan([]), exitSignal: "SIGKILL" as const },
    activePlan([
      ...Array.from({ length: 10_001 }, () => ({
        type: "status",
        session_id: CL02_SESSION_ID,
        status: "running",
      })),
    ]),
  ] as const) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L12", {
      turnPlan: plan,
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain");
  }

  const clock = createCl02Clock();
  const timedOut = await createCl02Adapter(t, "CL02-CL03:L12", {
    clock,
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [{ kind: "json", value: replayRecord("CL02 untrusted input") }],
      onStdinEnd: "resist",
    },
  });
  const timedOutEvents = collectEvents(timedOut.adapter.start(startRequest()));
  await timedOut.fake.waitForInputRecords(1);
  clock.advance(100_000);
  assert.equal(eventName((await timedOutEvents).at(-1)), "uncertain");
});

test("CL02-L13 enforces raw UTF-8 JSONL record and depth boundaries", async (t) => {
  const invalidWrites = [
    { kind: "base64" as const, value: Buffer.from([0xff, 0x0a]).toString("base64") },
    { kind: "utf8" as const, value: '{"type":"status","type":"status"}\n' },
    { kind: "utf8" as const, value: "[]\n" },
    { kind: "utf8" as const, value: "{}{}\n" },
    { kind: "utf8" as const, value: "3\n" },
    { kind: "json" as const, value: { type: "unknown", session_id: CL02_SESSION_ID } },
    { kind: "utf8" as const, value: '{"type":"status"}' },
    { kind: "json" as const, value: nestedRecordAtDepth(101) },
    { kind: "json" as const, value: assistantRecordAtBytes(1_048_577) },
  ];
  for (const write of invalidWrites) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L13", {
      turnPlan: {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
        writesAfterInput: [{ kind: "json", value: replayRecord("CL02 untrusted input") }, write],
      },
    });
    assert.equal(
      eventName((await collectEvents(adapter.start(startRequest()))).at(-1)),
      "uncertain",
    );
  }

  for (const boundary of [nestedRecordAtDepth(100), assistantRecordAtBytes(1_048_576)]) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L13", {
      turnPlan: activePlan([boundary, resultRecord("boundary accepted")]),
    });
    assert.equal(eventName((await collectEvents(adapter.start(startRequest()))).at(-1)), "reply");
  }
});

test("CL02-L14 preserves the common ID event output reply and deadline limits", async (t) => {
  const exactReply = "r".repeat(262_144);
  const exact = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: activePlan([resultRecord(exactReply)]),
  });
  const accepted = await collectEvents(exact.adapter.start(startRequest()));
  assert.equal((accepted.at(-1) as { text?: unknown }).text, exactReply);

  const overEventPlan = activePlan([
    ...Array.from({ length: 10_000 }, () => ({
      type: "status",
      session_id: CL02_SESSION_ID,
      status: "running",
    })),
    resultRecord("must not pass"),
  ]);
  const overEvent = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: overEventPlan,
  });
  assert.equal(
    eventName((await collectEvents(overEvent.adapter.start(startRequest()))).at(-1)),
    "uncertain",
  );

  const overId = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: activePlan([
      { ...assistantRecord("private"), uuid: "u".repeat(1_025) },
      resultRecord("must not pass"),
    ]),
  });
  assert.equal(
    eventName((await collectEvents(overId.adapter.start(startRequest()))).at(-1)),
    "uncertain",
  );
  assert.equal(CL02_INPUT_UUID.length <= 1_024, true);

  const exactStdout = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: stdoutBoundaryPlan(8_388_608),
  });
  assert.equal(
    eventName((await collectEvents(exactStdout.adapter.start(startRequest()))).at(-1)),
    "reply",
  );
  const overStdout = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: stdoutBoundaryPlan(8_388_609),
  });
  assert.equal(
    eventName((await collectEvents(overStdout.adapter.start(startRequest()))).at(-1)),
    "uncertain",
  );

  const exactStderr = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: { ...activePlan([resultRecord("stderr boundary")]), stderrBytes: 8_388_608 },
  });
  assert.equal(
    eventName((await collectEvents(exactStderr.adapter.start(startRequest()))).at(-1)),
    "reply",
  );
  const overStderr = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: { ...activePlan([]), stderrBytes: 8_388_609 },
  });
  assert.equal(
    eventName((await collectEvents(overStderr.adapter.start(startRequest()))).at(-1)),
    "uncertain",
  );

  const exactEventPlan = activePlan([
    ...Array.from({ length: 9_998 }, () => ({
      type: "status",
      session_id: CL02_SESSION_ID,
      status: "running",
    })),
    resultRecord("event boundary"),
  ]);
  const exactEvents = await createCl02Adapter(t, "CL02-CL03:L14", {
    turnPlan: exactEventPlan,
  });
  const exactEventResult = await collectEvents(exactEvents.adapter.start(startRequest()));
  assert.equal(eventName(exactEventResult.at(-1)), "reply");
  assert.equal(exactEventResult.length, 10_000);
  assert.deepEqual(
    exactEventResult.filter((event) => eventName(event) === "progress"),
    Array.from({ length: 9_998 }, () => ({
      event: "progress",
      execution_id: CL02_EXECUTION_ID,
      text: "provider_activity",
    })),
  );

  const clock = createCl02Clock();
  const deadline = await createCl02Adapter(t, "CL02-CL03:L14", {
    clock,
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [{ kind: "json", value: replayRecord("CL02 untrusted input") }],
      onStdinEnd: "resist",
    },
  });
  const deadlineEvents = collectEvents(deadline.adapter.start(startRequest()));
  await deadline.fake.waitForInputRecords(1);
  let settled = false;
  void deadlineEvents.finally(() => {
    settled = true;
  });
  clock.advance(99_999);
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  assert.equal(eventName((await deadlineEvents).at(-1)), "uncertain");
});
