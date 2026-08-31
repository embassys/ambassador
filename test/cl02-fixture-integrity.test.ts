import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  exactClaudeArguments,
  initRecord,
  inputRecord,
  resultRecord,
  startFakeClaudeCli,
  startFakeClaudeMonitor,
  syntheticCl02Environment,
} from "./support/claude-code/index.js";

async function completion(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

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

async function nextJson(lines: AsyncIterator<string>): Promise<unknown> {
  const record = await lines.next();
  assert.equal(record.done, false);
  assert.equal(typeof record.value, "string");
  return JSON.parse(record.value as string) as unknown;
}

test("CL02 support runs the fake Claude version and stream-JSON turn without real credentials", async (t) => {
  const cwd = process.cwd();
  const text = "fixture input";
  const fake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(cwd) }],
      writesAfterInput: [
        { kind: "json", value: inputRecord(text) },
        { kind: "json", value: resultRecord("fixture reply") },
      ],
    },
  ]);
  const environment = syntheticCl02Environment("fixture-integrity");

  const version = fake.spawnForFixture(["--version"], { cwd, env: environment });
  const versionBytes: Buffer[] = [];
  version.stdout?.on("data", (chunk: Buffer) => versionBytes.push(Buffer.from(chunk)));
  assert.deepEqual(await completion(version), { code: 0, signal: null });
  assert.equal(Buffer.concat(versionBytes).toString("utf8"), "2.1.251 (Claude Code)\n");

  const turn = fake.spawnForFixture(exactClaudeArguments("start"), { cwd, env: environment });
  assert.ok(turn.stdout !== null && turn.stdin !== null);
  const output = createInterface({
    input: turn.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  })[Symbol.asyncIterator]();
  assert.deepEqual(await nextJson(output), initRecord(cwd));
  turn.stdin.end(`${JSON.stringify(inputRecord(text))}\n`);
  const replay = await nextJson(output);
  const result = await nextJson(output);
  assert.deepEqual(await completion(turn), { code: 0, signal: null });
  assert.deepEqual(replay, inputRecord(text));
  assert.deepEqual(result, resultRecord("fixture reply"));
  assert.deepEqual(fake.launches[1]?.stdinRecords, [JSON.stringify(inputRecord(text))]);
  assert.equal(fake.launches[1]?.stdinClosed, true);
});

test("CL02 support runs the six-pipe detached monitor and same-group fake Claude topology", async (t) => {
  const cwd = process.cwd();
  const fake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
  ]);
  const monitor = await startFakeClaudeMonitor(t, [{}]);
  const environment = syntheticCl02Environment("monitor-integrity");
  const child = monitor.spawnForAdapter(
    process.execPath,
    ["/reviewed/claude-lifetime-monitor.js"],
    {
      cwd,
      env: environment,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  assert.ok(child.pid !== undefined);
  const pid = child.pid;
  const status = createInterface({
    input: readableFd(child, 5),
    crlfDelay: Number.POSITIVE_INFINITY,
  })[Symbol.asyncIterator]();
  assert.equal((await status.next()).value, '{"type":"ready"}');
  writableFd(child, 4).write(
    `${JSON.stringify({ type: "start", executable: fake.executablePath, arguments: ["--version"] })}\n`,
  );
  assert.equal((await status.next()).value, '{"type":"child_started"}');
  assert.equal((await status.next()).value, '{"type":"child_exited","code":0,"signal":null}');
  writableFd(child, 4).write('{"type":"contain"}\n');
  assert.deepEqual(await completion(child), { code: null, signal: "SIGKILL" });
  assert.throws(
    () => process.kill(-pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
  assert.deepEqual(monitor.launches[0], {
    requestedExecutable: process.execPath,
    requestedArguments: ["/reviewed/claude-lifetime-monitor.js"],
    requestedCwd: cwd,
    requestedEnvironment: environment,
    requestedDetached: true,
    requestedShell: false,
    requestedStdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    pid,
    commands: [
      { type: "start", executable: fake.executablePath, arguments: ["--version"] },
      { type: "contain" },
    ],
    ownerClosed: false,
    barriers: [],
    signals: ["SIGTERM"],
    seals: ["contain"],
  });
  assert.deepEqual(fake.launches[0]?.arguments, ["--version"]);
  assert.equal(fake.launches[0]?.pid === pid, false);
});
