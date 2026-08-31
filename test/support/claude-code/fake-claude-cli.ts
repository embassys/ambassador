#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

import type { FakeClaudeProcessPlan, FakeClaudeWireWrite } from "./types.js";

type ControllerMessage =
  | { readonly command: "plan"; readonly plan: FakeClaudeProcessPlan }
  | { readonly command: "release"; readonly gate: string };

const executable = realpathSync(process.argv[1] ?? "");
const arguments_ = process.argv.slice(2);
const control = connect(`${executable}.control.sock`);
const gates = new Map<string, (() => void)[]>();
let plan: FakeClaudeProcessPlan | undefined;

function send(value: unknown): void {
  control.write(`${JSON.stringify(value)}\n`);
}

function environmentRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function mode(): "version" | "turn" {
  return arguments_.length === 1 && arguments_[0] === "--version" ? "version" : "turn";
}

function releaseGate(name: string): void {
  const waiters = gates.get(name) ?? [];
  gates.delete(name);
  for (const release of waiters) release();
}

async function waitForGate(name: string | undefined): Promise<void> {
  if (name === undefined) return;
  send({ channel: "barrier", name });
  await new Promise<void>((resolve) => {
    const waiters = gates.get(name) ?? [];
    waiters.push(resolve);
    gates.set(name, waiters);
  });
}

async function writeWire(write: FakeClaudeWireWrite): Promise<void> {
  await waitForGate(write.gate);
  if (write.kind === "json") {
    process.stdout.write(`${JSON.stringify(write.value)}\n`);
    return;
  }
  if (write.kind === "utf8") {
    process.stdout.write(write.value);
    return;
  }
  if (write.kind === "stderr_utf8") {
    process.stderr.write(write.value);
    return;
  }
  process.stdout.write(Buffer.from(write.value, "base64"));
}

function failFixture(code: string): never {
  send({ channel: "fixture_error", code });
  process.exit(91);
}

function spawnDescendant(): number | undefined {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    detached: false,
    env: {},
    shell: false,
    stdio: "ignore",
  });
  return child.pid;
}

function spawnOutputDescendant(value: string): number | undefined {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1] ?? '')", value],
    {
      detached: false,
      env: {},
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return child.pid;
}

async function runVersion(selected: Extract<FakeClaudeProcessPlan, { kind: "version" }>) {
  if (selected.spawnDescendant === true) {
    send({ channel: "descendant", pid: spawnDescendant() });
  }
  if (selected.hold === true) return;
  if (selected.stdout !== undefined) process.stdout.write(selected.stdout);
  if (selected.stderr !== undefined) process.stderr.write(selected.stderr);
  if (selected.stderrBytes !== undefined) {
    process.stderr.write(Buffer.alloc(selected.stderrBytes, 0x78));
  }
  if (selected.exitSignal !== undefined) {
    process.kill(process.pid, selected.exitSignal);
    return;
  }
  process.exit(selected.exitCode ?? 0);
}

async function runTurn(selected: Extract<FakeClaudeProcessPlan, { kind: "turn" }>) {
  if (selected.stderrBytes !== undefined) {
    process.stderr.write(Buffer.alloc(selected.stderrBytes, 0x78));
  }
  if (selected.spawnDescendant === true) {
    send({ channel: "descendant", pid: spawnDescendant() });
  }
  if (selected.stdoutBytesBeforeInput !== undefined) {
    process.stdout.write(Buffer.alloc(selected.stdoutBytesBeforeInput, 0x78));
  }
  for (const write of selected.writesBeforeInput ?? []) await writeWire(write);
  if (selected.exitBeforeInput?.exitSignal !== undefined) {
    process.kill(process.pid, selected.exitBeforeInput.exitSignal);
    return;
  }
  if (selected.exitBeforeInput?.exitCode !== undefined) {
    process.exit(selected.exitBeforeInput.exitCode);
  }
  process.stdin.on("data", (chunk: Buffer) => {
    send({ channel: "stdin_bytes", value: Buffer.from(chunk).toString("base64") });
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let inputCount = 0;
  let tail = Promise.resolve();
  input.on("line", (raw) => {
    tail = tail.then(async () => {
      inputCount += 1;
      send({ channel: "stdin", raw });
      if (inputCount === 1) {
        for (const write of selected.writesAfterInput ?? []) await writeWire(write);
        if (selected.stdoutBytesAfterInput !== undefined) {
          process.stdout.write(Buffer.alloc(selected.stdoutBytesAfterInput, 0x78));
        }
      }
    });
  });
  input.on("close", () => {
    void tail.then(async () => {
      send({ channel: "stdin_closed" });
      for (const write of selected.writesAfterStdinEnd ?? []) await writeWire(write);
      if (selected.descendantStdoutAfterStdinEnd !== undefined) {
        send({
          channel: "descendant",
          pid: spawnOutputDescendant(selected.descendantStdoutAfterStdinEnd),
        });
      }
      await waitForGate(selected.stdinEndGate);
      if (selected.onStdinEnd === "resist") return;
      if (selected.onStdinEnd === "linger") {
        await new Promise<void>((resolve) => setTimeout(resolve, selected.lingerMs ?? 1_500));
      }
      if (selected.exitSignal !== undefined) {
        process.kill(process.pid, selected.exitSignal);
        return;
      }
      process.exit(selected.exitCode ?? 0);
    });
  });
}

process.on("SIGINT", () => {
  send({ channel: "signal", signal: "SIGINT" });
  if (plan?.kind === "turn" && plan.exitOnInterrupt === true) process.exit(130);
});
process.on("SIGTERM", () => {
  send({ channel: "signal", signal: "SIGTERM" });
  if (plan?.kind !== "turn" || plan.resistTermination !== true) process.exit(143);
});

const messages = createInterface({ input: control, crlfDelay: Number.POSITIVE_INFINITY });
messages.on("line", (line) => {
  let message: ControllerMessage;
  try {
    message = JSON.parse(line) as ControllerMessage;
  } catch {
    failFixture("controller_json_invalid");
  }
  if (message.command === "release") {
    releaseGate(message.gate);
    return;
  }
  if (message.command !== "plan" || plan !== undefined) failFixture("controller_plan_invalid");
  plan = message.plan;
  if (mode() !== plan.kind) failFixture("plan_mode_mismatch");
  const operation = plan.kind === "version" ? runVersion(plan) : runTurn(plan);
  void operation.catch(() => failFixture("fixture_execution_failed"));
});

control.once("connect", () => {
  send({
    channel: "hello",
    executable,
    mode: mode(),
    arguments: arguments_,
    cwd: process.cwd(),
    environment: environmentRecord(),
    pid: process.pid,
  });
});
control.once("error", () => process.exit(92));
