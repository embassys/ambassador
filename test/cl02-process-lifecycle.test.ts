import assert from "node:assert/strict";
import test from "node:test";

import {
  CL02_EXECUTION_ID,
  type ClaudeAdapterProcessBarrier,
  cancelRequest,
  collectEvents,
  createCl02Adapter,
  initRecord,
  loadCl03Production,
  replayRecord,
  resultRecord,
  startFakeClaudeCli,
  startFakeClaudeMonitor,
  startRequest,
  syntheticCl02Environment,
} from "./support/claude-code/index.js";
import {
  startClaudeOwnerHarness as startOwnerWorker,
  stopClaudeOwnerHarness as stopWorker,
  waitForClaudeProcessGroupEmpty as waitForGroupEmpty,
} from "./support/claude-code/owner-harness.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("CL02-L15 owner EOF seals the known group across every startup and execution barrier", async (t) => {
  await loadCl03Production("CL02-CL03:L15");
  const phases: readonly {
    readonly name: ClaudeAdapterProcessBarrier;
    readonly source: "adapter" | "monitor";
  }[] = [
    { name: "before_monitor_ready", source: "adapter" },
    { name: "before_start_write", source: "adapter" },
    { name: "during_start_record", source: "monitor" },
    { name: "before_claude_spawn", source: "monitor" },
    { name: "after_claude_spawn", source: "monitor" },
    { name: "before_child_started", source: "monitor" },
    { name: "after_child_started", source: "adapter" },
    { name: "before_init", source: "adapter" },
    { name: "after_session_bound", source: "adapter" },
    { name: "during_stdin_write", source: "adapter" },
    { name: "after_replay", source: "adapter" },
    { name: "during_tools", source: "adapter" },
    { name: "after_terminal_candidate", source: "adapter" },
  ];
  for (const phase of phases) {
    const monitorPlan =
      phase.source !== "monitor"
        ? phase.name === "before_monitor_ready"
          ? { holdBeforeReady: true }
          : {}
        : phase.name === "during_start_record"
          ? { startRecordGate: phase.name }
          : phase.name === "before_claude_spawn"
            ? { beforeSpawnGate: phase.name }
            : phase.name === "after_claude_spawn"
              ? { afterSpawnGate: phase.name }
              : { beforeChildStartedGate: phase.name };
    const monitor =
      phase.source === "monitor" ? await startFakeClaudeMonitor(t, [{}, monitorPlan]) : undefined;
    if (monitor !== undefined) {
      const options = {
        cwd: process.cwd(),
        env: syntheticCl02Environment("owner-provider"),
        detached: true as const,
        shell: false as const,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"] as const,
      };
      monitor.registerExternalLaunch(process.execPath, ["production-monitor"], options);
      monitor.registerExternalLaunch(process.execPath, ["production-monitor"], options);
    }
    const toolRecord = {
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000209",
      session_id: "00000000-0000-4000-8000-000000000101",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "." } }],
      },
      parent_tool_use_id: null,
    };
    const fake = await startFakeClaudeCli(t, [
      { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
      {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json", value: replayRecord(`phase:${phase.name}`) },
          { kind: "json", value: toolRecord },
          { kind: "json", value: resultRecord("held terminal") },
        ],
        spawnDescendant: true,
        onStdinEnd: "resist",
        resistTermination: true,
      },
    ]);
    const owner = await startOwnerWorker({
      executablePath: fake.executablePath,
      input: `phase:${phase.name}`,
      barrier: phase.name,
      ...(monitor === undefined ? {} : { monitorModulePath: monitor.modulePath }),
    });
    if (phase.source === "monitor") await monitor?.waitForBarrier(phase.name);
    else await owner.waitForBarrier(phase.name);
    await owner.waitForMonitorCount(2);
    const monitorMessages = owner.messages.filter((entry) => entry.channel === "monitor");
    const pgid = monitorMessages.at(-1)?.pid;
    assert.equal(typeof pgid, "number");
    await stopWorker(owner.worker);
    await waitForGroupEmpty(pgid as number);
    assert.equal(
      owner.messages.some(
        (entry) => entry.channel === "event" && eventName(entry.value) === "reply",
      ),
      false,
    );
  }
});

test("CL02-L16 recovery starts no Claude or monitor and always returns uncertainty", async (t) => {
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L16", {
    turnPlan: { kind: "turn", onStdinEnd: "resist" },
  });
  const launchesBefore = fake.launches.length;
  for (const providerTurnId of [null, "unexpected_turn"] as const) {
    const events = await collectEvents(
      adapter.recover({
        kind: "recover",
        execution_id: CL02_EXECUTION_ID,
        conversation_id: "cl02_conversation_1",
        message_id: "cl02_message_1",
        provider_session_id: "00000000-0000-4000-8000-000000000101",
        provider_turn_id: providerTurnId,
        deadline_unix_ms: 1_788_000_900_000,
      }),
    );
    assert.deepEqual(events, [
      {
        event: "uncertain",
        execution_id: CL02_EXECUTION_ID,
        reason_code: "provider_outcome_unknown",
      },
    ]);
  }
  assert.equal(fake.launches.length, launchesBefore);
});

test("CL02-L17 interrupt signals only the known monitor group and never claims safe cancellation", async (t) => {
  const phases: readonly {
    readonly name: ClaudeAdapterProcessBarrier;
    readonly status: "cancel_requested" | "already_terminal";
    readonly interrupts: 0 | 1;
  }[] = [
    { name: "before_init", status: "cancel_requested", interrupts: 1 },
    { name: "after_session_bound", status: "cancel_requested", interrupts: 1 },
    { name: "during_stdin_write", status: "cancel_requested", interrupts: 1 },
    { name: "after_replay", status: "cancel_requested", interrupts: 1 },
    { name: "after_terminal_candidate", status: "already_terminal", interrupts: 0 },
    { name: "after_child_exited", status: "already_terminal", interrupts: 0 },
  ];
  for (const phase of phases) {
    const monitor = await startFakeClaudeMonitor(t, [{}, { selfSealOnContain: false }]);
    let releaseBarrier: (() => void) | undefined;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let reachBarrier: (() => void) | undefined;
    const barrierReached = new Promise<void>((resolve) => {
      reachBarrier = resolve;
    });
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L17", {
      spawnMonitorForTest: monitor.spawnForAdapter,
      turnPlan: {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json", value: replayRecord("CL02 untrusted input") },
          { kind: "json", value: resultRecord("held cancellation candidate") },
        ],
        exitOnInterrupt: true,
      },
      async processBarrierForTest(event) {
        if (event.scope !== "turn" || event.barrier !== phase.name) return;
        reachBarrier?.();
        await barrierReleased;
      },
    });
    const eventsPromise = collectEvents(adapter.start(startRequest()));
    let barrierTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      barrierReached,
      new Promise<never>((_resolve, reject) => {
        barrierTimeout = setTimeout(
          () => reject(new Error(`CL02 cancellation did not reach ${phase.name}`)),
          5_000,
        );
      }),
    ]).finally(() => clearTimeout(barrierTimeout));
    const cancellation = await adapter.cancel(cancelRequest());
    assert.deepEqual(cancellation, { status: phase.status });
    releaseBarrier?.();
    const events = await eventsPromise;
    const turn = fake.launches.filter((entry) => entry.mode === "turn").at(-1);
    assert.deepEqual(turn?.signals ?? [], phase.interrupts === 1 ? ["SIGINT"] : []);
    assert.equal(
      monitor.launches
        .at(-1)
        ?.commands.filter((entry) => (entry as { type?: unknown }).type === "interrupt").length ??
        0,
      phase.interrupts,
    );
    assert.equal(
      events.some((event) => eventName(event) === "cancelled"),
      false,
    );
  }
});

test("CL02-L18 seals and proves the full group before every terminal provider event", async (t) => {
  const cases = [
    {
      name: "normal exit",
      terminal: "reply",
      plan: {
        kind: "turn" as const,
        writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json" as const, value: replayRecord("CL02 untrusted input") },
          { kind: "json" as const, value: resultRecord("exact") },
        ],
      },
    },
    {
      name: "prompt EOF with live descendant",
      terminal: "reply",
      plan: {
        kind: "turn" as const,
        writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json" as const, value: replayRecord("CL02 untrusted input") },
          { kind: "json" as const, value: resultRecord("exact") },
        ],
        spawnDescendant: true,
        onStdinEnd: "resist" as const,
        resistTermination: true,
      },
    },
    ...(["SIGINT", "SIGTERM", "SIGKILL"] as const).map((exitSignal) => ({
      name: `provider ${exitSignal}`,
      terminal: "uncertain",
      plan: {
        kind: "turn" as const,
        writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json" as const, value: replayRecord("CL02 untrusted input") },
          { kind: "json" as const, value: resultRecord("held") },
        ],
        exitSignal,
      },
    })),
  ];
  for (const vector of cases) {
    const monitor = await startFakeClaudeMonitor(t, [
      { selfSealOnContain: false },
      { selfSealOnContain: false },
    ]);
    let groupProved = false;
    const observations: string[] = [];
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L18", {
      spawnMonitorForTest: monitor.spawnForAdapter,
      turnPlan: vector.plan,
      processObserverForTest(event) {
        if (event.scope === "turn") observations.push(event.observation);
        if (event.scope === "turn" && event.observation === "group_empty_proved") {
          groupProved = true;
        }
      },
    });
    const events: unknown[] = [];
    for await (const event of adapter.start(startRequest())) {
      if (!["session_bound", "progress"].includes(String(eventName(event)))) {
        assert.equal(groupProved, true, `${vector.name} delivered terminal before cleanup`);
      }
      events.push(event);
    }
    assert.equal(groupProved, true, vector.name);
    assert.equal(eventName(events.at(-1)), vector.terminal, vector.name);
    const turnMonitor = monitor.launches.at(-1);
    assert.ok(turnMonitor !== undefined);
    assert.equal(
      turnMonitor.commands.some((entry) => (entry as { type?: unknown }).type === "contain"),
      true,
      vector.name,
    );
    assert.equal(groupExists(turnMonitor.pid), false, vector.name);
    const ordered = [
      "contain_written",
      "sigterm_sent",
      "sigkill_sent",
      "monitor_reaped",
      "group_empty_proved",
    ];
    assert.deepEqual(
      observations.filter((entry) => ordered.includes(entry)),
      ordered,
      vector.name,
    );
  }

  const monitor = await startFakeClaudeMonitor(t, [
    { selfSealOnContain: false },
    { selfSealOnContain: false },
  ]);
  let cancellationGroupProved = false;
  const cancellationObservations: string[] = [];
  const cancelled = await createCl02Adapter(t, "CL02-CL03:L18", {
    spawnMonitorForTest: monitor.spawnForAdapter,
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [{ kind: "json", value: replayRecord("CL02 untrusted input") }],
      exitOnInterrupt: true,
    },
    processObserverForTest(event) {
      if (event.scope === "turn") {
        cancellationObservations.push(event.observation);
        if (event.observation === "group_empty_proved") cancellationGroupProved = true;
      }
    },
  });
  const cancellationEvents = (async () => {
    const events: unknown[] = [];
    for await (const event of cancelled.adapter.start(startRequest())) {
      if (!["session_bound", "progress"].includes(String(eventName(event)))) {
        assert.equal(cancellationGroupProved, true);
      }
      events.push(event);
    }
    return events;
  })();
  await cancelled.fake.waitForInputRecords(1);
  await cancelled.adapter.cancel(cancelRequest());
  assert.equal(eventName((await cancellationEvents).at(-1)), "uncertain");
  assert.deepEqual(
    cancellationObservations.filter((entry) =>
      [
        "contain_written",
        "sigterm_sent",
        "sigkill_sent",
        "monitor_reaped",
        "group_empty_proved",
      ].includes(entry),
    ),
    ["contain_written", "sigterm_sent", "sigkill_sent", "monitor_reaped", "group_empty_proved"],
  );
  const cancelledMonitor = monitor.launches.at(-1);
  assert.ok(cancelledMonitor !== undefined);
  assert.equal(groupExists(cancelledMonitor.pid), false);
});

test("CL02-L19 invalidates a terminal candidate on every late provider or monitor conflict", async (t) => {
  const lateRecords = [
    resultRecord("conflict"),
    { type: "assistant", session_id: "wrong", message: { role: "assistant", content: [] } },
    { type: "unknown_control", detail: "private" },
  ];
  for (const late of lateRecords) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L19", {
      turnPlan: {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json", value: replayRecord("CL02 untrusted input") },
          { kind: "json", value: resultRecord("candidate") },
          { kind: "json", value: late },
        ],
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain");
    assert.ok(!JSON.stringify(events).includes("private"));
  }

  const monitorConflicts = [
    {
      name: "duplicate child start",
      write: { type: "child_started" },
    },
    {
      name: "monitor internal fault",
      write: { type: "fault", code: "internal_failure" },
    },
    {
      name: "out-of-order child exit",
      write: { type: "child_exited", code: 0, signal: null },
    },
  ] as const;
  for (const conflict of monitorConflicts) {
    const monitor = await startFakeClaudeMonitor(t, [{}, { selfSealOnContain: false }]);
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L19", {
      turnPlan: {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
        writesAfterInput: [
          { kind: "json", value: replayRecord("CL02 untrusted input") },
          { kind: "json", value: resultRecord("candidate") },
        ],
        onStdinEnd: "resist",
        resistTermination: true,
      },
      spawnMonitorForTest: monitor.spawnForAdapter,
      async processBarrierForTest(event) {
        if (event.scope !== "turn" || event.barrier !== "after_terminal_candidate") return;
        monitor.emitLifecycle({ kind: "json", value: conflict.write });
        await monitor.waitForBarrier("fixture_emit_complete");
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain", conflict.name);
    assert.equal(
      monitor.launches.every((entry) => !groupExists(entry.pid)),
      true,
      conflict.name,
    );
  }

  const descendantDetail = "CL02_DESCENDANT_PRIVATE_OUTPUT\n";
  const descendant = await createCl02Adapter(t, "CL02-CL03:L19", {
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [
        { kind: "json", value: replayRecord("CL02 untrusted input") },
        { kind: "json", value: resultRecord("candidate") },
      ],
      descendantStdoutAfterStdinEnd: descendantDetail,
    },
  });
  const descendantEvents = await collectEvents(descendant.adapter.start(startRequest()));
  assert.equal(eventName(descendantEvents.at(-1)), "uncertain");
  assert.ok(!JSON.stringify(descendantEvents).includes(descendantDetail.trim()));
});
