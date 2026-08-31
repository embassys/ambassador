#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { connect } from "node:net";
import { constants } from "node:os";
import { createInterface } from "node:readline";

import type { FakeClaudeWireWrite, FakeMonitorPlan } from "./types.js";

type ControllerMessage =
  | { readonly command: "plan"; readonly plan: FakeMonitorPlan }
  | { readonly command: "release"; readonly gate: string }
  | { readonly command: "emit"; readonly write: FakeClaudeWireWrite };

interface StartCommand {
  readonly type: "start";
  readonly executable: string;
  readonly arguments: readonly string[];
}

const modulePath = realpathSync(process.argv[1] ?? "");
const fixtureControl = connect(`${modulePath}.control.sock`);
const owner = createReadStream("/dev/null", { fd: 3, autoClose: false });
const commands = createReadStream("/dev/null", { fd: 4, autoClose: false });
const lifecycle = createWriteStream("/dev/null", { fd: 5, autoClose: false });
const gates = new Map<string, (() => void)[]>();
let plan: FakeMonitorPlan | undefined;
let child: ReturnType<typeof spawn> | undefined;
let sealing = false;

function sendFixture(value: unknown): void {
  fixtureControl.write(`${JSON.stringify(value)}\n`);
}

function releaseGate(name: string): void {
  const waiters = gates.get(name) ?? [];
  gates.delete(name);
  for (const release of waiters) release();
}

async function waitForGate(name: string | undefined): Promise<void> {
  if (name === undefined) return;
  sendFixture({ channel: "barrier", name });
  await new Promise<void>((resolve) => {
    const waiters = gates.get(name) ?? [];
    waiters.push(resolve);
    gates.set(name, waiters);
  });
}

async function writeLifecycle(write: FakeClaudeWireWrite): Promise<void> {
  await waitForGate(write.gate);
  if (write.kind === "json") {
    lifecycle.write(`${JSON.stringify(write.value)}\n`);
    return;
  }
  if (write.kind === "utf8") {
    lifecycle.write(write.value);
    return;
  }
  if (write.kind === "base64") {
    lifecycle.write(Buffer.from(write.value, "base64"));
    return;
  }
  process.stderr.write(write.value);
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null;
  return constants.signals[signal];
}

function seal(reason: string): void {
  if (sealing) return;
  sealing = true;
  sendFixture({ channel: "seal", reason });
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      sendFixture({ channel: "fixture_error", code: "monitor_term_failed" });
    }
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        sendFixture({ channel: "fixture_error", code: "monitor_kill_failed" });
      }
    }
  }, 50).unref();
}

process.on("SIGINT", () => sendFixture({ channel: "signal", signal: "SIGINT" }));
process.on("SIGTERM", () => sendFixture({ channel: "signal", signal: "SIGTERM" }));
process.on("uncaughtException", () => seal("uncaught_exception"));
process.on("unhandledRejection", () => seal("unhandled_rejection"));

owner.once("end", () => {
  sendFixture({ channel: "owner_closed" });
  seal("owner_closed");
});
owner.once("error", () => seal("owner_error"));
commands.once("error", () => seal("command_error"));
lifecycle.once("error", () => seal("lifecycle_error"));
process.stdin.pause();

async function startClaude(command: StartCommand): Promise<void> {
  await waitForGate(plan?.startRecordGate);
  for (const write of plan?.afterStartWrites ?? []) await writeLifecycle(write);
  await waitForGate(plan?.beforeSpawnGate);
  if (plan?.spawnClaude === false) return;
  child = spawn(command.executable, [...command.arguments], {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("spawn", () => {
    void (async () => {
      await waitForGate(plan?.afterSpawnGate);
      await waitForGate(plan?.beforeChildStartedGate);
      lifecycle.write('{"type":"child_started"}\n');
      process.stdin.pipe(child?.stdin ?? process.stdout);
      child?.stdout?.pipe(process.stdout);
      child?.stderr?.pipe(process.stderr);
    })().catch(() => seal("child_started_failed"));
  });
  child.once("error", () => {
    lifecycle.write('{"type":"fault","code":"spawn_failed"}\n');
    seal("spawn_failed");
  });
  child.once("close", (code, signal) => {
    lifecycle.write(
      `${JSON.stringify({ type: "child_exited", code, signal: signalNumber(signal) })}\n`,
    );
  });
}

const commandLines = createInterface({ input: commands, crlfDelay: Number.POSITIVE_INFINITY });
let started = false;
commandLines.on("line", (line) => {
  let command: unknown;
  try {
    command = JSON.parse(line);
  } catch {
    lifecycle.write('{"type":"fault","code":"invalid_control"}\n');
    seal("invalid_control");
    return;
  }
  sendFixture({ channel: "command", value: command });
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    seal("invalid_control");
    return;
  }
  const record = command as Readonly<Record<string, unknown>>;
  if (record.type === "start" && !started) {
    started = true;
    void startClaude(record as unknown as StartCommand).catch(() => seal("start_failed"));
    return;
  }
  if (record.type === "interrupt") {
    try {
      process.kill(-process.pid, "SIGINT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") seal("interrupt_failed");
    }
    return;
  }
  if (record.type === "contain") {
    if (plan?.selfSealOnContain !== false) seal("contain");
    return;
  }
  lifecycle.write('{"type":"fault","code":"invalid_control"}\n');
  seal("invalid_control");
});

const fixtureLines = createInterface({
  input: fixtureControl,
  crlfDelay: Number.POSITIVE_INFINITY,
});
fixtureLines.on("line", (line) => {
  let message: ControllerMessage;
  try {
    message = JSON.parse(line) as ControllerMessage;
  } catch {
    seal("fixture_control_invalid");
    return;
  }
  if (message.command === "release") {
    releaseGate(message.gate);
    return;
  }
  if (message.command === "emit") {
    void writeLifecycle(message.write)
      .then(() => sendFixture({ channel: "barrier", name: "fixture_emit_complete" }))
      .catch(() => seal("fixture_emit_failed"));
    return;
  }
  if (message.command !== "plan" || plan !== undefined) {
    seal("fixture_plan_invalid");
    return;
  }
  plan = message.plan;
  void (async () => {
    if (plan?.holdBeforeReady === true) return;
    const writes = plan?.readyWrites ?? [{ kind: "json", value: { type: "ready" } }];
    for (const write of writes) await writeLifecycle(write);
  })().catch(() => seal("ready_failed"));
});
fixtureControl.once("connect", () => {
  sendFixture({ channel: "hello", pid: process.pid, cwd: process.cwd() });
});
fixtureControl.once("error", () => seal("fixture_control_error"));
