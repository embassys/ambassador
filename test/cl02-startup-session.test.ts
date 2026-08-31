import assert from "node:assert/strict";
import { appendFile, chmod } from "node:fs/promises";
import test from "node:test";

import {
  CL02_EXECUTION_ID,
  CL02_SESSION_ID,
  collectEvents,
  createCl02Adapter,
  createCl02Clock,
  exactClaudeArguments,
  initRecord,
  inputRecord,
  loadCl03Production,
  replayRecord,
  resultRecord,
  resumeRequest,
  startFakeClaudeCli,
  startFakeClaudeMonitor,
  startRequest,
  syntheticCl02Environment,
  validTurnPlan,
} from "./support/claude-code/index.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

test("CL02-L01 pins the monitored executable identity and exact 2.1.251 version", async (t) => {
  const cwd = process.cwd();
  for (const versionPlan of [
    { kind: "version", stdout: "2.1.250 (Claude Code)\n" },
    { kind: "version", stdout: "2.1.251-beta.1 (Claude Code)\n" },
    { kind: "version", stdout: "2.1.252 (Claude Code)\n" },
    { kind: "version", stdout: `${"x".repeat(65)}\n` },
    { kind: "version", stderr: "private failure", exitCode: 1 },
    { kind: "version", stderrBytes: 1_025 },
    { kind: "version", exitSignal: "SIGKILL" },
  ] as const) {
    const monitor = await startFakeClaudeMonitor(t, [{ selfSealOnContain: false }]);
    const observations: string[] = [];
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L01", {
      versionPlan,
      turnPlan: validTurnPlan(cwd),
      spawnMonitorForTest: monitor.spawnForAdapter,
      processObserverForTest(event) {
        if (event.scope === "version") observations.push(event.observation);
      },
    });
    const events: unknown[] = [];
    for await (const event of adapter.start(startRequest())) {
      if (eventName(event) === "failed") {
        assert.equal(observations.at(-1), "group_empty_proved");
      }
      events.push(event);
    }
    assert.deepEqual(events, [
      {
        event: "failed",
        execution_id: CL02_EXECUTION_ID,
        reason_code: "provider_start_failed",
      },
    ]);
    assert.deepEqual(
      observations.filter((observation) =>
        [
          "contain_written",
          "sigterm_sent",
          "sigkill_sent",
          "monitor_reaped",
          "group_empty_proved",
        ].includes(observation),
      ),
      ["contain_written", "sigterm_sent", "sigkill_sent", "monitor_reaped", "group_empty_proved"],
    );
    const pgid = monitor.launches[0]?.pid;
    assert.equal(typeof pgid, "number");
    assert.throws(
      () => process.kill(-(pgid as number), 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.equal(fake.launches.filter((entry) => entry.mode === "turn").length, 0);
  }

  const timeoutClock = createCl02Clock();
  const timeoutMonitor = await startFakeClaudeMonitor(t, [{ selfSealOnContain: false }]);
  const timeoutObservations: string[] = [];
  const timedOutAdapter = createCl02Adapter(t, "CL02-CL03:L01", {
    clock: timeoutClock,
    versionPlan: { kind: "version", hold: true },
    turnPlan: validTurnPlan(cwd),
    spawnMonitorForTest: timeoutMonitor.spawnForAdapter,
    processObserverForTest(event) {
      if (event.scope === "version") timeoutObservations.push(event.observation);
    },
  });
  for (
    let attempt = 0;
    attempt < 100 && timeoutClock.pendingTimerCountForTest() === 0;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(timeoutClock.pendingTimerCountForTest(), 1);
  timeoutClock.advance(5_000);
  const timedOut = await timedOutAdapter;
  const timeoutEvents: unknown[] = [];
  for await (const event of timedOut.adapter.start(startRequest())) {
    if (eventName(event) === "failed") {
      assert.equal(timeoutObservations.at(-1), "group_empty_proved");
    }
    timeoutEvents.push(event);
  }
  assert.deepEqual(timeoutEvents, [
    { event: "failed", execution_id: CL02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);
  assert.deepEqual(
    timeoutObservations.filter((observation) =>
      [
        "contain_written",
        "sigterm_sent",
        "sigkill_sent",
        "monitor_reaped",
        "group_empty_proved",
      ].includes(observation),
    ),
    ["contain_written", "sigterm_sent", "sigkill_sent", "monitor_reaped", "group_empty_proved"],
  );
  const timeoutPgid = timeoutMonitor.launches[0]?.pid;
  assert.equal(typeof timeoutPgid, "number");
  assert.throws(
    () => process.kill(-(timeoutPgid as number), 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );

  const readinessClock = createCl02Clock();
  const readinessMonitor = await startFakeClaudeMonitor(t, [
    { holdBeforeReady: true, selfSealOnContain: false },
  ]);
  const readinessFake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
  ]);
  const readinessObservations: string[] = [];
  const readinessModule = await loadCl03Production("CL02-CL03:L01");
  const readinessFactory = readinessModule.createClaudeCodeAdapterForTest({
    workingDirectory: cwd,
    policy: "read-only",
    inheritedEnvironment: syntheticCl02Environment("readiness-timeout"),
    webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: readinessFake.executablePath,
    clock: readinessClock,
    spawnMonitorForTest: readinessMonitor.spawnForAdapter,
    processObserverForTest(event) {
      if (event.scope === "version") readinessObservations.push(event.observation);
    },
  });
  await readinessMonitor.waitForLaunches(1);
  for (
    let attempt = 0;
    attempt < 100 && readinessClock.pendingTimerCountForTest() === 0;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(readinessClock.pendingTimerCountForTest(), 1);
  readinessClock.advance(5_000);
  const readinessAdapter = await readinessFactory;
  t.after(async () => await readinessAdapter.close());
  assert.deepEqual(await collectEvents(readinessAdapter.start(startRequest())), [
    { event: "failed", execution_id: CL02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);
  assert.deepEqual(readinessObservations, [
    "monitor_pid_recorded",
    "sigterm_sent",
    "sigkill_sent",
    "monitor_reaped",
    "group_empty_proved",
  ]);
  const readinessPgid = readinessMonitor.launches[0]?.pid;
  assert.equal(typeof readinessPgid, "number");
  assert.throws(
    () => process.kill(-(readinessPgid as number), 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );

  const missing = await createCl02Adapter(t, "CL02-CL03:L01", {
    fixtureExecutablePath: null,
    turnPlan: validTurnPlan(cwd),
  });
  assert.deepEqual(await collectEvents(missing.adapter.start(startRequest())), [
    { event: "failed", execution_id: CL02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);

  const fake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    validTurnPlan(cwd),
  ]);
  const module = await import("./support/claude-code/cl03-production.js").then(
    async ({ loadCl03Production }) => await loadCl03Production("CL02-CL03:L01"),
  );
  const adapter = await module.createClaudeCodeAdapterForTest({
    workingDirectory: cwd,
    policy: "read-only",
    inheritedEnvironment: syntheticCl02Environment("identity-change"),
    webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: fake.executablePath,
    uuidForTest: (kind) =>
      kind === "session" ? CL02_SESSION_ID : "00000000-0000-4000-8000-000000000102",
    afterVersionProbeForTest: async () => {
      await appendFile(fake.executablePath, "\n");
      await chmod(fake.executablePath, 0o700);
    },
  });
  t.after(async () => await adapter.close());
  assert.deepEqual(await collectEvents(adapter.start(startRequest())), [
    { event: "failed", execution_id: CL02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);
});

test("CL02-L02 launches the exact detached monitor and same-group Claude child", async (t) => {
  const cwd = process.cwd();
  for (const policy of ["read-only", "workspace-write"] as const) {
    const home = `launch-${policy}`;
    const monitor = await startFakeClaudeMonitor(t, [{}, {}, {}]);
    const inherited = {
      ...syntheticCl02Environment(home),
      CL02_WEBHOOK_TOKEN: "a".repeat(48),
      ANTHROPIC_API_KEY: "forbidden",
      CLAUDE_CODE_OAUTH_TOKEN: "forbidden",
      NODE_OPTIONS: "--import=forbidden",
      A2A_REMOTE_COMMAND: "forbidden",
    };
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L02", {
      workingDirectory: cwd,
      policy,
      inheritedEnvironment: inherited,
      turnPlan: validTurnPlan(cwd, "CL02 untrusted input", policy),
      spawnMonitorForTest: monitor.spawnForAdapter,
    });
    await collectEvents(adapter.start(startRequest()));
    fake.enqueue(validTurnPlan(cwd, "CL02 continuation", policy));
    await collectEvents(adapter.resume(resumeRequest()));
    assert.equal(monitor.launches.length, 3);
    for (const launch of monitor.launches) {
      assert.equal(launch.requestedExecutable, process.execPath);
      assert.equal(launch.requestedArguments.length, 1);
      assert.match(launch.requestedArguments[0] ?? "", /claude-lifetime-monitor\.js$/u);
      assert.equal(launch.requestedCwd, cwd);
      assert.equal(launch.requestedDetached, true);
      assert.equal(launch.requestedShell, false);
      assert.deepEqual(launch.requestedStdio, ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]);
      assert.ok(!JSON.stringify(launch).includes("CL02 untrusted input"));
      assert.deepEqual(launch.requestedEnvironment, syntheticCl02Environment(home));
    }
    assert.deepEqual(
      monitor.launches.map((entry) => entry.commands[0]),
      [
        { type: "start", executable: fake.executablePath, arguments: ["--version"] },
        {
          type: "start",
          executable: fake.executablePath,
          arguments: exactClaudeArguments("start", policy),
        },
        {
          type: "start",
          executable: fake.executablePath,
          arguments: exactClaudeArguments("resume", policy),
        },
      ],
    );
    assert.ok(
      monitor.launches.every((entry) =>
        [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "NODE_OPTIONS",
          "A2A_REMOTE_COMMAND",
          "CL02_WEBHOOK_TOKEN",
        ].every((name) => !Object.hasOwn(entry.requestedEnvironment, name)),
      ),
    );
  }
});

test("CL02-L03 accepts only one exact init before provider input", async (t) => {
  const cwd = process.cwd();
  const variants: readonly { readonly name: string; readonly record?: unknown }[] = [
    { name: "input before init", record: replayRecord("early") },
    { name: "missing init" },
    { name: "hook before init", record: { type: "system", subtype: "hook_started" } },
    { name: "wrong session", record: initRecord(cwd, { sessionId: "wrong" }) },
    { name: "wrong cwd", record: initRecord("/wrong") },
    { name: "wrong version", record: { ...initRecord(cwd), claude_code_version: "2.1.250" } },
    { name: "wrong tools", record: { ...initRecord(cwd), tools: ["Bash"] } },
    {
      name: "wrong permission",
      record: { ...initRecord(cwd), permissionMode: "bypassPermissions" },
    },
    { name: "MCP configured", record: { ...initRecord(cwd), mcp_servers: [{ name: "private" }] } },
    { name: "plugin configured", record: { ...initRecord(cwd), plugins: [{ name: "private" }] } },
  ];
  for (const variant of variants) {
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L03", {
      turnPlan: {
        kind: "turn",
        ...(variant.record === undefined
          ? { onStdinEnd: "resist" }
          : { writesBeforeInput: [{ kind: "json", value: variant.record }] }),
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "failed", variant.name);
    assert.deepEqual(fake.launches.at(-1)?.stdinRecords, [], variant.name);
  }
});

test("CL02-L04 leaves stdin empty until the durable session-bound pull barrier", async (t) => {
  const cwd = process.cwd();
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L04", {
    turnPlan: validTurnPlan(cwd),
  });
  const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, {
    event: "session_bound",
    execution_id: CL02_EXECUTION_ID,
    provider_session_id: CL02_SESSION_ID,
  });
  assert.deepEqual(fake.launches.at(-1)?.stdinRecords, []);
  const terminal = await iterator.next();
  assert.equal(eventName(terminal.value), "reply");
  assert.deepEqual(fake.launches.at(-1)?.stdinRecords, [
    JSON.stringify(inputRecord("CL02 untrusted input")),
  ]);
});

test("CL02-L05 resumes only the exact stored session and never starts a replacement", async (t) => {
  const cwd = process.cwd();
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L05", {
    turnPlan: validTurnPlan(cwd, "CL02 continuation"),
  });
  const events = await collectEvents(adapter.resume(resumeRequest()));
  assert.equal(eventName(events.at(-1)), "reply");
  assert.deepEqual(fake.launches.at(-1)?.arguments, exactClaudeArguments("resume"));
  assert.ok(!fake.launches.at(-1)?.arguments.includes("--continue"));
  assert.ok(!fake.launches.at(-1)?.arguments.includes("--fork-session"));

  for (const providerSessionId of ["", "not-a-uuid", "s".repeat(1_025)]) {
    const malformed = await createCl02Adapter(t, "CL02-CL03:L05", {
      turnPlan: validTurnPlan(cwd, "CL02 continuation"),
    });
    const malformedRequest = { ...resumeRequest(), provider_session_id: providerSessionId };
    assert.notEqual(
      eventName((await collectEvents(malformed.adapter.resume(malformedRequest))).at(-1)),
      "reply",
    );
    assert.equal(malformed.fake.launches.filter((entry) => entry.mode === "turn").length, 0);
  }

  const mismatched = await createCl02Adapter(t, "CL02-CL03:L05", {
    turnPlan: {
      ...validTurnPlan(cwd, "CL02 continuation"),
      writesBeforeInput: [
        {
          kind: "json",
          value: initRecord(cwd, { sessionId: "00000000-0000-4000-8000-000000000999" }),
        },
      ],
    },
  });
  assert.notEqual(
    eventName((await collectEvents(mismatched.adapter.resume(resumeRequest()))).at(-1)),
    "reply",
  );
  assert.ok(!mismatched.fake.launches.at(-1)?.arguments.includes("--session-id"));

  const missing = await createCl02Adapter(t, "CL02-CL03:L05", {
    turnPlan: { kind: "turn", exitCode: 1, stderrBytes: 64 },
  });
  assert.notEqual(
    eventName((await collectEvents(missing.adapter.resume(resumeRequest()))).at(-1)),
    "reply",
  );
  assert.deepEqual(missing.fake.launches.at(-1)?.arguments, exactClaudeArguments("resume"));
});

test("CL02-L06 places adversarial A2A bytes only in one structured stdin text block", async (t) => {
  const text = '$(touch /tmp/no)\n--model=evil\n{"settings":"override"}\n/skill\nA=B';
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L06", {
    turnPlan: validTurnPlan(process.cwd(), text),
  });
  await collectEvents(adapter.start(startRequest(text)));
  const launch = fake.launches.at(-1);
  assert.deepEqual(launch?.stdinRecords, [JSON.stringify(inputRecord(text))]);
  assert.deepEqual(
    Buffer.from(launch?.stdinBase64 ?? "", "base64"),
    Buffer.from(`${JSON.stringify(inputRecord(text))}\n`),
  );
  assert.equal(launch?.stdinClosed, true);
  for (const value of [...(launch?.arguments ?? []), ...Object.values(launch?.environment ?? {})]) {
    assert.equal(value.includes(text), false);
    assert.equal(value.includes("$(touch /tmp/no)"), false);
    assert.equal(value.includes("--model=evil"), false);
  }
});

test("CL02-L07 requires one byte-exact replay and derives no recovery handle from it", async (t) => {
  const cwd = process.cwd();
  for (const replay of [
    undefined,
    replayRecord("changed"),
    { ...replayRecord("CL02 untrusted input"), uuid: "00000000-0000-4000-8000-000000000999" },
    { ...replayRecord("CL02 untrusted input"), session_id: "wrong" },
    { ...replayRecord("CL02 untrusted input"), parent_tool_use_id: "tool" },
  ]) {
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L07", {
      turnPlan: {
        kind: "turn",
        writesBeforeInput: [{ kind: "json", value: initRecord(cwd) }],
        writesAfterInput: [
          ...(replay === undefined ? [] : [{ kind: "json" as const, value: replay }]),
          { kind: "json", value: resultRecord("must not pass") },
        ],
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), "uncertain");
    assert.equal(
      events.some((event) => eventName(event) === "turn_bound"),
      false,
    );
  }
});

test("CL02-L08 fixes restricted safe dontAsk tool ceilings for both connector policies", async (t) => {
  for (const policy of ["read-only", "workspace-write"] as const) {
    const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L08", {
      policy,
      turnPlan: validTurnPlan(process.cwd(), "CL02 untrusted input", policy),
    });
    await collectEvents(adapter.start(startRequest()));
    const arguments_ = fake.launches.at(-1)?.arguments ?? [];
    assert.deepEqual(arguments_, exactClaudeArguments("start", policy));
    assert.ok(arguments_.includes("--safe-mode"));
    assert.ok(arguments_.includes("--restricted"));
    assert.ok(arguments_.includes("dontAsk"));
    for (const forbidden of ["--allowedTools", "acceptEdits", "auto", "bypassPermissions"]) {
      assert.ok(!arguments_.includes(forbidden));
    }
  }
});
