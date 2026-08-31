#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

import type { FakeClaudeProcessPlan, FakeClaudeWireWrite } from "./types.js";

type ControllerMessage =
  | { readonly command: "plan"; readonly plan: FakeClaudeProcessPlan }
  | { readonly command: "release"; readonly gate: string }
  | { readonly command: "signal_ack"; readonly signal: NodeJS.Signals };

const executable = realpathSync(process.argv[1] ?? "");
const arguments_ = process.argv.slice(2);
const control = connect(`${executable}.control.sock`);
const gates = new Map<string, (() => void)[]>();
const signalAcknowledgements = new Map<NodeJS.Signals, (() => void)[]>();
let plan: FakeClaudeProcessPlan | undefined;

function send(value: unknown): void {
  control.write(`${JSON.stringify(value)}\n`);
}

async function sendFully(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    control.write(`${JSON.stringify(value)}\n`, (error?: Error | null) =>
      error === undefined || error === null ? resolve() : reject(error),
    );
  });
}

async function sendSignal(signal: NodeJS.Signals): Promise<void> {
  const acknowledged = new Promise<void>((resolve) => {
    const waiters = signalAcknowledgements.get(signal) ?? [];
    waiters.push(resolve);
    signalAcknowledgements.set(signal, waiters);
  });
  await sendFully({ channel: "signal", signal });
  await acknowledged;
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

async function writeFully(stream: NodeJS.WriteStream, value: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error?: Error | null) =>
      error === undefined || error === null ? resolve() : reject(error),
    );
  });
}

async function writeWire(write: FakeClaudeWireWrite): Promise<void> {
  await waitForGate(write.gate);
  if (write.kind === "json") {
    await writeFully(process.stdout, `${JSON.stringify(write.value)}\n`);
    return;
  }
  if (write.kind === "utf8") {
    await writeFully(process.stdout, write.value);
    return;
  }
  if (write.kind === "stderr_utf8") {
    await writeFully(process.stderr, write.value);
    return;
  }
  await writeFully(process.stdout, Buffer.from(write.value, "base64"));
}

function failFixture(code: string): never {
  send({ channel: "fixture_error", code });
  process.exit(91);
}

function exitBySignal(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
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
  if (selected.stdout !== undefined) await writeFully(process.stdout, selected.stdout);
  if (selected.stderr !== undefined) await writeFully(process.stderr, selected.stderr);
  if (selected.stderrBytes !== undefined) {
    await writeFully(process.stderr, Buffer.alloc(selected.stderrBytes, 0x78));
  }
  if (selected.exitSignal !== undefined) {
    exitBySignal(selected.exitSignal);
    return;
  }
  process.exit(selected.exitCode ?? 0);
}

async function runTurn(selected: Extract<FakeClaudeProcessPlan, { kind: "turn" }>) {
  const pendingStderr =
    selected.stderrBytes === undefined
      ? Promise.resolve()
      : writeFully(process.stderr, Buffer.alloc(selected.stderrBytes, 0x78));
  if (selected.spawnDescendant === true) {
    send({ channel: "descendant", pid: spawnDescendant() });
  }
  if (selected.stdoutBytesBeforeInput !== undefined) {
    await writeFully(process.stdout, Buffer.alloc(selected.stdoutBytesBeforeInput, 0x78));
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
          await writeFully(process.stdout, Buffer.alloc(selected.stdoutBytesAfterInput, 0x78));
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
      await pendingStderr;
      if (selected.onStdinEnd === "resist") return;
      if (selected.onStdinEnd === "linger") {
        await new Promise<void>((resolve) => setTimeout(resolve, selected.lingerMs ?? 1_500));
      }
      if (selected.exitSignal !== undefined) {
        exitBySignal(selected.exitSignal);
        return;
      }
      process.exit(selected.exitCode ?? 0);
    });
  });
}

process.on("SIGINT", () => {
  void sendSignal("SIGINT").then(() => {
    if (plan?.kind === "turn" && plan.exitOnInterrupt === true) process.exit(130);
  });
});
process.on("SIGTERM", () => {
  void sendSignal("SIGTERM").then(() => {
    if (plan?.kind !== "turn" || plan.resistTermination !== true) process.exit(143);
  });
});

const messages = createInterface({ input: control, crlfDelay: Number.POSITIVE_INFINITY });
messages.on("line", (line) => {
  let message: ControllerMessage;
  try {
    message = JSON.parse(line) as ControllerMessage;
  } catch {
    failFixture("controller_json_invalid");
  }
  if (message.command === "signal_ack") {
    const waiters = signalAcknowledgements.get(message.signal) ?? [];
    const acknowledge = waiters.shift();
    if (waiters.length === 0) signalAcknowledgements.delete(message.signal);
    else signalAcknowledgements.set(message.signal, waiters);
    if (acknowledge === undefined) failFixture("controller_signal_ack_invalid");
    acknowledge();
    return;
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
