#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

import type { FakeCodexExchange, FakeCodexProcessPlan, FakeCodexWireWrite } from "./types.js";

type ControllerMessage =
  | { readonly command: "plan"; readonly plan: FakeCodexProcessPlan }
  | { readonly command: "release"; readonly gate: string }
  | { readonly command: "exit" };

const executable = realpathSync(process.argv[1] ?? "");
const arguments_ = process.argv.slice(2);
const control = connect(`${executable}.control.sock`);
const gates = new Map<string, (() => void)[]>();

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

function mode(): "version" | "app-server" | "invalid" {
  if (arguments_.length === 1 && arguments_[0] === "--version") return "version";
  if (
    JSON.stringify(arguments_) ===
    JSON.stringify(["app-server", "--listen", "stdio://", "--strict-config"])
  ) {
    return "app-server";
  }
  return "invalid";
}

function releaseGate(name: string): void {
  const waiters = gates.get(name) ?? [];
  gates.delete(name);
  for (const release of waiters) release();
}

async function waitForGate(name: string | undefined): Promise<void> {
  if (name === undefined) return;
  await new Promise<void>((resolve) => {
    const waiters = gates.get(name) ?? [];
    waiters.push(resolve);
    gates.set(name, waiters);
  });
}

async function writeWire(write: FakeCodexWireWrite): Promise<void> {
  await waitForGate(write.gate);
  if (write.kind === "json") {
    process.stdout.write(`${JSON.stringify(write.value)}\n`);
    return;
  }
  if (write.kind === "utf8") {
    process.stdout.write(write.value);
    return;
  }
  process.stdout.write(Buffer.from(write.value, "base64"));
}

function failFixture(code: string): never {
  send({ channel: "fixture_error", code });
  process.exit(91);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runExchange(
  exchange: FakeCodexExchange,
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (request.method !== exchange.expectMethod) failFixture("unexpected_method");
  if (exchange.expectRequest !== undefined && !sameJson(request, exchange.expectRequest)) {
    failFixture("unexpected_request");
  }
  for (const write of exchange.beforeResponse ?? []) await writeWire(write);
  if (exchange.result !== undefined || exchange.error !== undefined) {
    if (!Number.isSafeInteger(request.id) || (request.id as number) <= 0) {
      failFixture("response_target_invalid");
    }
    const response =
      exchange.error === undefined
        ? { id: request.id, result: exchange.result }
        : { id: request.id, error: exchange.error };
    await writeWire({ kind: "json", value: response });
  }
  for (const write of exchange.afterResponse ?? []) await writeWire(write);
  if (exchange.exitCodeAfter !== undefined) process.exit(exchange.exitCodeAfter);
}

async function runAppServer(
  plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }>,
): Promise<void> {
  let exchangeIndex = 0;
  let tail = Promise.resolve();
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  input.on("line", (line) => {
    tail = tail.then(async () => {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        failFixture("adapter_json_invalid");
      }
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        failFixture("adapter_envelope_invalid");
      }
      const record = request as Readonly<Record<string, unknown>>;
      send({ channel: "request", raw: line, value: record });
      const exchange = plan.exchanges[exchangeIndex];
      if (exchange === undefined) failFixture("unexpected_request_count");
      exchangeIndex += 1;
      await runExchange(exchange, record);
    });
  });
  input.on("close", () => {
    tail = tail.then(async () => {
      send({ channel: "stdin_closed" });
      for (const write of plan.writesAfterStdinEnd ?? []) await writeWire(write);
      if (plan.onStdinEnd === "resist") return;
      if (plan.onStdinEnd === "linger") {
        await new Promise<void>((resolve) => setTimeout(resolve, plan.lingerMs ?? 1_500));
      }
      process.exit(0);
    });
  });
  if (plan.spawnDescendant === true) {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      detached: false,
      env: {},
      shell: false,
      stdio: "ignore",
    });
    send({ channel: "descendant", pid: descendant.pid });
  }
}

async function run(plan: FakeCodexProcessPlan): Promise<void> {
  const selectedMode = mode();
  if (selectedMode !== plan.kind) failFixture("plan_mode_mismatch");
  if (plan.kind === "version") {
    if (plan.hold === true) return;
    if (plan.stdout !== undefined) process.stdout.write(plan.stdout);
    if (plan.stderr !== undefined) process.stderr.write(plan.stderr);
    process.exit(plan.exitCode ?? 0);
  }
  await runAppServer(plan);
}

const messages = createInterface({ input: control, crlfDelay: Number.POSITIVE_INFINITY });
let planned = false;
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
  if (message.command === "exit") process.exit(0);
  if (message.command !== "plan" || planned) failFixture("controller_command_invalid");
  planned = true;
  void run(message.plan).catch(() => failFixture("fixture_execution_failed"));
});
control.once("connect", () => {
  send({
    channel: "hello",
    mode: mode(),
    arguments: arguments_,
    cwd: process.cwd(),
    environment: environmentRecord(),
  });
});
control.once("error", () => process.exit(92));

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

void (control satisfies Socket);
