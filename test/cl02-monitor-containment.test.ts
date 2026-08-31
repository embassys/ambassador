import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CL02_EXECUTION_ID,
  type ClaudeLifetimeMonitorBarrier,
  collectEvents,
  createCl02Adapter,
  createCl02Clock,
  exactClaudeArguments,
  initRecord,
  inputRecord,
  loadCl03Production,
  replayRecord,
  resultRecord,
  startFakeClaudeCli,
  startFakeClaudeMonitor,
  startRequest,
  syntheticCl02Environment,
  validTurnPlan,
} from "./support/claude-code/index.js";
import {
  startClaudeOwnerHarness as startOwnerWorker,
  stopClaudeOwnerHarness as stopWorker,
  waitForClaudeProcessGroupEmpty as waitForGroupEmpty,
} from "./support/claude-code/owner-harness.js";

function writableFd(child: ChildProcess, index: number): NodeJS.WritableStream {
  const stream = child.stdio[index];
  assert.ok(stream !== undefined && stream !== null && "write" in stream);
  return stream;
}

function readableFd(child: ChildProcess, index: number): NodeJS.ReadableStream {
  const stream = child.stdio[index];
  assert.ok(stream !== undefined && stream !== null && "read" in stream);
  return stream;
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

async function completion(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

async function boundedMonitorCompletion(
  child: ChildProcess,
  pgid: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const survived = groupExists(pgid);
      if (survived) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            reject(error);
            return;
          }
        }
      }
      reject(new Error("production monitor did not self-seal after its internal fault"));
    }, 4_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function productionMonitorPath(): string {
  return fileURLToPath(
    new URL("../packages/claude-connector/src/claude-lifetime-monitor.js", import.meta.url),
  );
}

test("CL02-L24 rejects every malformed command lifecycle overflow and forged group claim", async (t) => {
  await loadCl03Production("CL02-CL03:L24");
  const monitorPath = productionMonitorPath();
  const probeRoot = await mkdtemp(join(tmpdir(), "a2a-cl02-monitor-probe-"));
  t.after(async () => await rm(probeRoot, { recursive: true, force: true }));
  const probeMarker = join(probeRoot, "spawned");
  const validProbe = join(probeRoot, "claude");
  const wrongProbe = join(probeRoot, "not-claude");
  const versionedProbe = join(probeRoot, "claude-2.1.251");
  const probeSource = [
    "#!/usr/bin/env node",
    `require("node:fs").appendFileSync(${JSON.stringify(probeMarker)}, "spawned\\n");`,
    "",
  ].join("\n");
  await writeFile(validProbe, probeSource, { mode: 0o700 });
  await writeFile(versionedProbe, probeSource, { mode: 0o700 });
  await symlink(versionedProbe, wrongProbe);
  await chmod(validProbe, 0o700);
  await chmod(versionedProbe, 0o700);
  const canonicalVersionedProbe = await realpath(versionedProbe);
  const resistantRoot = join(probeRoot, "resistant");
  await mkdir(resistantRoot, { mode: 0o700 });
  const resistantProbe = join(resistantRoot, "claude");
  await writeFile(
    resistantProbe,
    [
      "#!/usr/bin/env node",
      'process.on("SIGTERM", () => {});',
      'process.on("SIGINT", () => {});',
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(resistantProbe, 0o700);
  const deepCommand = (() => {
    let value: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) value = [value];
    return `${JSON.stringify({ type: "start", executable: "/invalid", arguments: value })}\n`;
  })();
  const commandCases = [
    { name: "malformed", command: "not-json\n" },
    { name: "array", command: "[]\n" },
    { name: "missing", command: "{}\n" },
    { name: "unknown", command: '{"type":"unknown"}\n' },
    { name: "release", command: '{"type":"release"}\n' },
    { name: "interrupt before start", command: '{"type":"interrupt"}\n' },
    { name: "contain before start", command: '{"type":"contain"}\n' },
    { name: "duplicate", command: '{"type":"start","type":"start"}\n' },
    {
      name: "unknown field",
      command: `${JSON.stringify({
        type: "start",
        executable: validProbe,
        arguments: ["--version"],
        extra: true,
      })}\n`,
    },
    {
      name: "relative executable",
      command: '{"type":"start","executable":"relative","arguments":["--version"]}\n',
    },
    {
      name: "wrong executable",
      command: `${JSON.stringify({
        type: "start",
        executable: wrongProbe,
        arguments: ["--version"],
      })}\n`,
    },
    {
      name: "wrong arguments",
      command: `${JSON.stringify({
        type: "start",
        executable: validProbe,
        arguments: ["--wrong"],
      })}\n`,
    },
    { name: "over depth", command: deepCommand },
    { name: "oversized", command: `${"x".repeat(16_385)}\n` },
    {
      name: "record count",
      command: Array.from({ length: 33 }, () => '{"type":"interrupt"}\n').join(""),
    },
    {
      name: "total bytes",
      command: Array.from({ length: 5 }, () => `${"x".repeat(16_000)}\n`).join(""),
    },
  ];

  const versionedChild = spawn(process.execPath, [monitorPath], {
    cwd: process.cwd(),
    env: syntheticCl02Environment("versioned-monitor-command"),
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  assert.ok(versionedChild.pid !== undefined);
  const versionedPgid = versionedChild.pid;
  const versionedStatus = createInterface({
    input: readableFd(versionedChild, 5),
    crlfDelay: Number.POSITIVE_INFINITY,
  })[Symbol.asyncIterator]();
  assert.equal((await versionedStatus.next()).value, '{"type":"ready"}');
  writableFd(versionedChild, 4).write(
    `${JSON.stringify({
      type: "start",
      executable: canonicalVersionedProbe,
      arguments: ["--version"],
    })}\n`,
  );
  assert.equal((await versionedStatus.next()).value, '{"type":"child_started"}');
  assert.match(String((await versionedStatus.next()).value), /^\{"type":"child_exited"/u);
  writableFd(versionedChild, 4).write('{"type":"contain"}\n');
  await completion(versionedChild);
  assert.equal(groupExists(versionedPgid), false);
  assert.equal(await readFile(probeMarker, "utf8"), "spawned\n");

  for (const vector of commandCases) {
    await rm(probeMarker, { force: true });
    const child = spawn(process.execPath, [monitorPath], {
      cwd: process.cwd(),
      env: syntheticCl02Environment("invalid-monitor-command"),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    assert.ok(child.pid !== undefined);
    const pgid = child.pid;
    const status = createInterface({
      input: readableFd(child, 5),
      crlfDelay: Number.POSITIVE_INFINITY,
    })[Symbol.asyncIterator]();
    assert.equal((await status.next()).value, '{"type":"ready"}');
    writableFd(child, 4).write(vector.command);
    await completion(child);
    assert.equal(groupExists(pgid), false, vector.name);
    await assert.rejects(readFile(probeMarker), /ENOENT/u, vector.name);
  }

  const deepLifecycle = (() => {
    let value: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) value = [value];
    return { type: "fault", code: "internal_failure", value };
  })();
  const lifecycleCases: readonly {
    readonly name: string;
    readonly writes: readonly {
      readonly kind: "json" | "utf8";
      readonly value: unknown;
    }[];
  }[] = [
    { name: "missing field", writes: [{ kind: "json", value: {} }] },
    {
      name: "duplicate field",
      writes: [{ kind: "utf8", value: '{"type":"child_started","type":"child_started"}\n' }],
    },
    {
      name: "unknown field",
      writes: [{ kind: "json", value: { type: "child_started", extra: true } }],
    },
    { name: "over depth", writes: [{ kind: "json", value: deepLifecycle }] },
    {
      name: "oversized record",
      writes: [{ kind: "utf8", value: `${"x".repeat(16_385)}\n` }],
    },
    {
      name: "record count",
      writes: Array.from({ length: 33 }, () => ({
        kind: "json" as const,
        value: { type: "child_started" },
      })),
    },
    {
      name: "total bytes",
      writes: Array.from({ length: 5 }, () => ({
        kind: "utf8" as const,
        value: `${"x".repeat(16_000)}\n`,
      })),
    },
    { name: "group claim", writes: [{ kind: "json", value: { type: "group_empty" } }] },
    { name: "release claim", writes: [{ kind: "json", value: { type: "released" } }] },
    { name: "no-child claim", writes: [{ kind: "json", value: { type: "no_child" } }] },
    {
      name: "forged group ID",
      writes: [{ kind: "json", value: { type: "child_started", pgid: 123 } }],
    },
    {
      name: "both child exit fields",
      writes: [{ kind: "json", value: { type: "child_exited", code: 0, signal: 9 } }],
    },
    {
      name: "neither child exit field",
      writes: [{ kind: "json", value: { type: "child_exited", code: null, signal: null } }],
    },
    {
      name: "negative child exit code",
      writes: [{ kind: "json", value: { type: "child_exited", code: -1, signal: null } }],
    },
    {
      name: "unknown signal",
      writes: [{ kind: "json", value: { type: "child_exited", code: null, signal: 999 } }],
    },
    {
      name: "unknown fault",
      writes: [{ kind: "json", value: { type: "fault", code: "unknown" } }],
    },
  ];
  for (const vector of lifecycleCases) {
    const fakeMonitor = await startFakeClaudeMonitor(t, [
      {},
      {
        readyWrites: [
          { kind: "json", value: { type: "ready" } },
          ...vector.writes.map((write) =>
            write.kind === "json"
              ? { kind: "json" as const, value: write.value }
              : { kind: "utf8" as const, value: String(write.value) },
          ),
        ],
        spawnClaude: false,
      },
    ]);
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L24", {
      turnPlan: validTurnPlan(process.cwd()),
      spawnMonitorForTest: fakeMonitor.spawnForAdapter,
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.notEqual((events.at(-1) as { event?: unknown }).event, "reply", vector.name);
    assert.equal(
      fakeMonitor.launches.every((entry) => !groupExists(entry.pid)),
      true,
      vector.name,
    );
  }

  for (const vector of [
    { name: "duplicate child start", value: { type: "child_started" } },
    { name: "child exit before start", value: { type: "child_exited", code: 0, signal: null } },
    { name: "lifecycle fault", value: { type: "fault", code: "internal_failure" } },
  ]) {
    const fakeMonitor = await startFakeClaudeMonitor(t, [
      {},
      {
        afterStartWrites: [{ kind: "json", value: vector.value }],
        spawnClaude: vector.name === "duplicate child start",
      },
    ]);
    const { adapter } = await createCl02Adapter(t, "CL02-CL03:L24", {
      turnPlan: validTurnPlan(process.cwd()),
      spawnMonitorForTest: fakeMonitor.spawnForAdapter,
    });
    assert.notEqual(
      eventName((await collectEvents(adapter.start(startRequest()))).at(-1)),
      "reply",
      vector.name,
    );
    assert.equal(
      fakeMonitor.launches.every((entry) => !groupExists(entry.pid)),
      true,
    );
  }

  for (const closeFd of [3, 4, 5] as const) {
    const child = spawn(process.execPath, [monitorPath], {
      cwd: process.cwd(),
      env: syntheticCl02Environment(`monitor-fd-${closeFd}`),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    assert.ok(child.pid !== undefined);
    const pgid = child.pid;
    const status = createInterface({
      input: readableFd(child, 5),
      crlfDelay: Number.POSITIVE_INFINITY,
    })[Symbol.asyncIterator]();
    assert.equal((await status.next()).value, '{"type":"ready"}');
    const stream = (
      child.stdio as readonly (NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined)[]
    )[closeFd];
    assert.ok(stream !== null && stream !== undefined);
    if (closeFd === 5) (stream as unknown as { destroy(): void }).destroy();
    else (stream as NodeJS.WritableStream).end();
    if (closeFd === 5) {
      writableFd(child, 4).write(
        `${JSON.stringify({
          type: "start",
          executable: resistantProbe,
          arguments: ["--version"],
        })}\n`,
      );
    }
    await completion(child);
    const gone = !groupExists(pgid);
    if (!gone) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    assert.equal(gone, true);
  }
});

test("CL02-L25 prompt EOF then owner death seals the monitor Claude and descendant group", async (t) => {
  await loadCl03Production("CL02-CL03:L25");
  const fake = await startFakeClaudeCli(t, [
    {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [{ kind: "json", value: replayRecord("prompt EOF") }],
      spawnDescendant: true,
      onStdinEnd: "resist",
      resistTermination: true,
    },
  ]);
  const monitor = spawn(process.execPath, [productionMonitorPath()], {
    cwd: process.cwd(),
    env: syntheticCl02Environment("prompt-eof-owner-death"),
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  assert.ok(monitor.pid !== undefined);
  const pgid = monitor.pid;
  const status = createInterface({
    input: readableFd(monitor, 5),
    crlfDelay: Number.POSITIVE_INFINITY,
  })[Symbol.asyncIterator]();
  assert.equal((await status.next()).value, '{"type":"ready"}');
  writableFd(monitor, 4).write(
    `${JSON.stringify({ type: "start", executable: fake.executablePath, arguments: exactClaudeArguments("start") })}\n`,
  );
  assert.equal((await status.next()).value, '{"type":"child_started"}');
  writableFd(monitor, 0).end(`${JSON.stringify(inputRecord("prompt EOF"))}\n`);
  await fake.waitForStdinClosed(1);
  writableFd(monitor, 3).end();
  await completion(monitor);
  assert.equal(groupExists(pgid), false);
  assert.equal(fake.launches[0]?.stdinClosed, true);
});

test("CL02-L26 owner death after terminal output discards the candidate and seals descendants", async (t) => {
  await loadCl03Production("CL02-CL03:L26");
  const fake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(process.cwd()) }],
      writesAfterInput: [
        { kind: "json", value: replayRecord("terminal then death") },
        { kind: "json", value: resultRecord("uncommitted terminal") },
      ],
      spawnDescendant: true,
      onStdinEnd: "resist",
      resistTermination: true,
    },
  ]);
  const owner = await startOwnerWorker({
    executablePath: fake.executablePath,
    input: "terminal then death",
    barrier: "after_terminal_candidate",
  });
  await owner.waitForBarrier("after_terminal_candidate");
  await owner.waitForMonitorCount(2);
  const pgid = owner.messages.filter((entry) => entry.channel === "monitor").at(-1)?.pid;
  assert.equal(typeof pgid, "number");
  assert.equal(
    owner.messages.some(
      (entry) =>
        entry.channel === "event" &&
        (entry.value as { event?: unknown } | undefined)?.event === "reply",
    ),
    false,
  );
  await stopWorker(owner.worker);
  await waitForGroupEmpty(pgid as number);
});

test("CL02-L27 orders PGID ready start lifecycle sealing reap and connector emptiness proof", async (t) => {
  const fakeMonitor = await startFakeClaudeMonitor(t, [
    { selfSealOnContain: false },
    { selfSealOnContain: false },
  ]);
  const observed: { scope: "version" | "turn"; observation: string }[] = [];
  const { adapter } = await createCl02Adapter(t, "CL02-CL03:L27", {
    turnPlan: validTurnPlan(process.cwd()),
    spawnMonitorForTest: fakeMonitor.spawnForAdapter,
    processObserverForTest: (event) => observed.push(event),
  });
  const events = await collectEvents(adapter.start(startRequest()));
  assert.equal((events.at(-1) as { event?: unknown }).event, "reply");
  assert.equal(fakeMonitor.launches.length, 2);
  for (const launch of fakeMonitor.launches) {
    const types = launch.commands.map((entry) => (entry as { type?: unknown }).type);
    assert.equal(types[0], "start");
    assert.equal(types.at(-1), "contain");
    assert.equal(types.includes("release"), false);
    assert.deepEqual(launch.signals, ["SIGTERM"]);
    assert.equal(groupExists(launch.pid), false);
  }
  const expected = [
    "monitor_pid_recorded",
    "ready",
    "start_written",
    "child_started",
    "child_exited",
    "contain_written",
    "sigterm_sent",
    "sigkill_sent",
    "monitor_reaped",
    "group_empty_proved",
  ];
  assert.deepEqual(
    observed.filter((entry) => entry.scope === "version").map((entry) => entry.observation),
    expected,
  );
  assert.deepEqual(
    observed.filter((entry) => entry.scope === "turn").map((entry) => entry.observation),
    expected,
  );

  const monitorFaultRoot = await mkdtemp(join(tmpdir(), "a2a-cl02-monitor-fault-"));
  t.after(async () => await rm(monitorFaultRoot, { recursive: true, force: true }));
  const monitorFaultMarker = join(monitorFaultRoot, "provider-started");
  const resistantClaude = join(monitorFaultRoot, "claude");
  await writeFile(
    resistantClaude,
    [
      "#!/usr/bin/env node",
      'process.on("SIGTERM", () => {});',
      'process.on("SIGINT", () => {});',
      `require("node:fs").appendFileSync(${JSON.stringify(monitorFaultMarker)}, "ready\\n");`,
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(resistantClaude, 0o700);
  const canonicalResistantClaude = await realpath(resistantClaude);
  const productionFaultWorker = fileURLToPath(
    new URL("./support/claude-code/production-monitor-fault-worker.js", import.meta.url),
  );
  const monitorFaultBarriers: readonly ClaudeLifetimeMonitorBarrier[] = [
    "before_monitor_ready",
    "during_start_record",
    "before_claude_spawn",
    "after_claude_spawn",
    "before_child_started",
  ];
  for (const barrier of monitorFaultBarriers) {
    await rm(monitorFaultMarker, { force: true });
    const child = spawn(process.execPath, [productionFaultWorker, barrier], {
      cwd: process.cwd(),
      env: syntheticCl02Environment(`production-monitor-fault-${barrier}`),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    assert.ok(child.pid !== undefined);
    const pgid = child.pid;
    const lifecycleRecords: string[] = [];
    createInterface({ input: readableFd(child, 5), crlfDelay: Number.POSITIVE_INFINITY }).on(
      "line",
      (line) => lifecycleRecords.push(line),
    );
    if (barrier !== "before_monitor_ready") {
      const deadline = Date.now() + 2_000;
      while (!lifecycleRecords.includes('{"type":"ready"}')) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
          throw new Error(`production monitor did not become ready at ${barrier}`);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      writableFd(child, 4).write(
        `${JSON.stringify({
          type: "start",
          executable: canonicalResistantClaude,
          arguments: exactClaudeArguments("start"),
        })}\n`,
      );
    }
    if (["after_claude_spawn", "before_child_started"].includes(barrier)) {
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          if ((await readFile(monitorFaultMarker, "utf8")) === "ready\n") break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
          throw new Error(`resistant provider did not become ready at ${barrier}`);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      process.kill(pgid, "SIGUSR2");
    }
    assert.deepEqual(await boundedMonitorCompletion(child, pgid), {
      code: null,
      signal: "SIGKILL",
    });
    assert.equal(
      lifecycleRecords.includes('{"type":"fault","code":"internal_failure"}'),
      true,
      barrier,
    );
    await waitForGroupEmpty(pgid);
    if (["after_claude_spawn", "before_child_started"].includes(barrier)) {
      assert.equal(await readFile(monitorFaultMarker, "utf8"), "ready\n", barrier);
    } else {
      await assert.rejects(readFile(monitorFaultMarker), /ENOENT/u, barrier);
    }
  }

  const faultTurnPlan = {
    kind: "turn" as const,
    writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd()) }],
    writesAfterInput: [
      { kind: "json" as const, value: replayRecord("CL02 untrusted input") },
      {
        kind: "json" as const,
        value: {
          type: "assistant",
          uuid: "00000000-0000-4000-8000-000000000701",
          session_id: "00000000-0000-4000-8000-000000000101",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool_1", name: "Read", input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      { kind: "json" as const, value: resultRecord("fault candidate") },
    ],
    spawnDescendant: true,
    resistTermination: true,
  };

  const adapterBarriers = [
    "before_monitor_ready",
    "before_start_write",
    "after_child_started",
    "before_init",
    "after_session_bound",
    "during_stdin_write",
    "after_replay",
    "during_tools",
    "after_terminal_candidate",
    "after_child_exited",
  ] as const;
  for (const barrier of adapterBarriers) {
    const faultMonitor = await startFakeClaudeMonitor(t, [
      { selfSealOnContain: false },
      { selfSealOnContain: false },
    ]);
    let killedPgid: number | undefined;
    const faulted = await createCl02Adapter(t, "CL02-CL03:L27", {
      turnPlan: faultTurnPlan,
      spawnMonitorForTest: faultMonitor.spawnForAdapter,
      async processBarrierForTest(event) {
        if (event.scope !== "turn" || event.barrier !== barrier) return;
        const launch = faultMonitor.launches.at(-1);
        assert.ok(launch !== undefined);
        killedPgid = launch.pid;
        process.kill(launch.pid, "SIGKILL");
      },
    });
    const faultEvents = await collectEvents(faulted.adapter.start(startRequest())).catch(
      (error: unknown) => {
        throw new Error(`monitor-death barrier ${barrier} failed`, { cause: error });
      },
    );
    assert.notEqual(eventName(faultEvents.at(-1)), "reply", barrier);
    assert.equal(typeof killedPgid, "number", barrier);
    assert.equal(groupExists(killedPgid as number), false, barrier);
  }

  for (const barrier of adapterBarriers) {
    const faultMonitor = await startFakeClaudeMonitor(t, [
      { selfSealOnContain: false },
      { selfSealOnContain: false },
    ]);
    let faultPgid: number | undefined;
    const faulted = await createCl02Adapter(t, "CL02-CL03:L27", {
      turnPlan: faultTurnPlan,
      spawnMonitorForTest: faultMonitor.spawnForAdapter,
      async processBarrierForTest(event) {
        if (event.scope !== "turn" || event.barrier !== barrier) return;
        const launch = faultMonitor.launches.at(-1);
        assert.ok(launch !== undefined);
        faultPgid = launch.pid;
        faultMonitor.emitLifecycle({
          kind: "json",
          value: { type: "fault", code: "internal_failure" },
        });
        await faultMonitor.waitForBarrier("fixture_emit_complete");
      },
    });
    const faultEvents = await collectEvents(faulted.adapter.start(startRequest()));
    assert.notEqual(eventName(faultEvents.at(-1)), "reply", barrier);
    assert.equal(typeof faultPgid, "number", barrier);
    assert.equal(groupExists(faultPgid as number), false, barrier);
  }

  const monitorBarriers = [
    { name: "during_start_record", plan: { startRecordGate: "during_start_record" } },
    { name: "before_claude_spawn", plan: { beforeSpawnGate: "before_claude_spawn" } },
    { name: "after_claude_spawn", plan: { afterSpawnGate: "after_claude_spawn" } },
    {
      name: "before_child_started",
      plan: { beforeChildStartedGate: "before_child_started" },
    },
  ] as const;
  for (const barrier of monitorBarriers) {
    const faultMonitor = await startFakeClaudeMonitor(t, [
      { selfSealOnContain: false },
      { ...barrier.plan, selfSealOnContain: false },
    ]);
    const faulted = await createCl02Adapter(t, "CL02-CL03:L27", {
      turnPlan: faultTurnPlan,
      spawnMonitorForTest: faultMonitor.spawnForAdapter,
    });
    const faultEvents = collectEvents(faulted.adapter.start(startRequest()));
    await faultMonitor.waitForBarrier(barrier.name);
    const pgid = faultMonitor.launches.at(-1)?.pid;
    assert.equal(typeof pgid, "number");
    process.kill(pgid as number, "SIGKILL");
    assert.notEqual(eventName((await faultEvents).at(-1)), "reply", barrier.name);
    assert.equal(groupExists(pgid as number), false, barrier.name);
  }

  for (const barrier of monitorBarriers) {
    const faultMonitor = await startFakeClaudeMonitor(t, [
      { selfSealOnContain: false },
      { ...barrier.plan, selfSealOnContain: false },
    ]);
    const faulted = await createCl02Adapter(t, "CL02-CL03:L27", {
      turnPlan: faultTurnPlan,
      spawnMonitorForTest: faultMonitor.spawnForAdapter,
    });
    const faultEvents = collectEvents(faulted.adapter.start(startRequest()));
    await faultMonitor.waitForBarrier(barrier.name);
    const pgid = faultMonitor.launches.at(-1)?.pid;
    assert.equal(typeof pgid, "number");
    faultMonitor.emitLifecycle({
      kind: "json",
      value: { type: "fault", code: "internal_failure" },
    });
    await faultMonitor.waitForBarrier("fixture_emit_complete");
    assert.notEqual(eventName((await faultEvents).at(-1)), "reply", barrier.name);
    assert.equal(groupExists(pgid as number), false, barrier.name);
  }

  const production = await loadCl03Production("CL02-CL03:L27");
  const deniedFake = await startFakeClaudeCli(t, []);
  const deniedStartedAt = Date.now();
  await assert.rejects(
    production.createClaudeCodeAdapterForTest({
      workingDirectory: process.cwd(),
      policy: "read-only",
      inheritedEnvironment: syntheticCl02Environment("denied-group-proof"),
      webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
      connectorPackageVersion: "0.0.0-private",
      fixtureExecutablePath: deniedFake.executablePath,
      clock: createCl02Clock(),
      processGroupProbeForTest: () => "denied",
      spawnMonitorForTest(_executable, _arguments, options) {
        return spawn(process.execPath, ["-e", "process.exit(0)"], {
          cwd: options.cwd,
          env: { ...options.env },
          detached: options.detached,
          shell: options.shell,
          stdio: [...options.stdio],
        });
      },
    }),
  );
  assert.ok(Date.now() - deniedStartedAt < 4_000, "denied proof exceeded one cleanup budget");

  const budgetFake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
  ]);
  const budgetMonitor = await startFakeClaudeMonitor(t, [{ selfSealOnContain: false }]);
  const lingeringMonitorSource = [
    'const { createReadStream, createWriteStream } = require("node:fs");',
    'const { createInterface } = require("node:readline");',
    'const owner = createReadStream("/dev/null", { fd: 3, autoClose: false });',
    'const commands = createReadStream("/dev/null", { fd: 4, autoClose: false });',
    'const lifecycle = createWriteStream("/dev/null", { fd: 5, autoClose: false });',
    "owner.resume();",
    'lifecycle.write("{\\"type\\":\\"ready\\"}\\n");',
    "let started = false;",
    "let contained = false;",
    'createInterface({ input: commands, crlfDelay: Infinity }).on("line", (line) => {',
    "  const record = JSON.parse(line);",
    '  if (record.type === "start" && !started) {',
    "    started = true;",
    '    lifecycle.write("{\\"type\\":\\"child_started\\"}\\n");',
    "    return;",
    "  }",
    '  if (record.type === "contain" && started && !contained) {',
    "    contained = true;",
    "    setTimeout(() => process.exit(0), 2500);",
    "  }",
    "});",
  ].join("\n");
  let monitorLaunches = 0;
  let lingeringPgid: number | undefined;
  let lingeringChild: ChildProcess | undefined;
  let releaseBeforeInit: (() => void) | undefined;
  const beforeInitReleased = new Promise<void>((resolve) => {
    releaseBeforeInit = resolve;
  });
  let reachBeforeInit: (() => void) | undefined;
  const beforeInitReached = new Promise<void>((resolve) => {
    reachBeforeInit = resolve;
  });
  const budgetAdapter = await production.createClaudeCodeAdapterForTest({
    workingDirectory: process.cwd(),
    policy: "read-only",
    inheritedEnvironment: syntheticCl02Environment("shared-cleanup-budget"),
    webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: budgetFake.executablePath,
    clock: createCl02Clock(),
    uuidForTest: (kind) =>
      kind === "session"
        ? "00000000-0000-4000-8000-000000000101"
        : "00000000-0000-4000-8000-000000000202",
    processGroupProbeForTest: (pgid) => (pgid === lingeringPgid ? "accessible" : "empty"),
    spawnMonitorForTest(executable, arguments_, options) {
      monitorLaunches += 1;
      if (monitorLaunches === 1) {
        return budgetMonitor.spawnForAdapter(executable, arguments_, options);
      }
      const child = spawn(process.execPath, ["-e", lingeringMonitorSource], {
        cwd: options.cwd,
        env: { ...options.env },
        detached: false,
        shell: options.shell,
        stdio: [...options.stdio],
      });
      lingeringPgid = child.pid;
      lingeringChild = child;
      return child;
    },
    async processBarrierForTest(event) {
      if (event.scope !== "turn" || event.barrier !== "before_init") return;
      reachBeforeInit?.();
      await beforeInitReleased;
    },
  });
  const budgetEvents = collectEvents(budgetAdapter.start(startRequest())).catch(
    (error: unknown) => error,
  );
  await beforeInitReached;
  const cleanupStartedAt = Date.now();
  assert.equal(await budgetAdapter.contain(CL02_EXECUTION_ID), false);
  const cleanupElapsedMs = Date.now() - cleanupStartedAt;
  assert.ok(cleanupElapsedMs >= 2_000, "cleanup did not wait for monitor close");
  assert.ok(cleanupElapsedMs < 4_000, "cleanup reset its absolute three-second budget");
  releaseBeforeInit?.();
  assert.ok((await budgetEvents) instanceof Error);
  const delayedMonitor = lingeringChild;
  assert.ok(delayedMonitor !== undefined);
  if (delayedMonitor.exitCode === null && delayedMonitor.signalCode === null) {
    const closed = completion(delayedMonitor);
    delayedMonitor.kill("SIGKILL");
    await closed;
  }
});
