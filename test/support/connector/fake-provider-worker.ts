import { createInterface } from "node:readline";

import type {
  FakeProviderEvent,
  FakeProviderRequest,
  FakeProviderStep,
  ProviderCancelRequest,
} from "./fake-provider-types.js";

interface InvokeCommand {
  command: "invoke";
  request: FakeProviderRequest;
  script: FakeProviderStep[];
}

interface PullCommand {
  command: "pull";
  request_id: number;
  execution_id: string;
}

interface CancelCommand {
  command: "cancel";
  request_id: number;
  request: ProviderCancelRequest;
}

interface ShutdownCommand {
  command: "shutdown";
}

type Command = InvokeCommand | PullCommand | CancelCommand | ShutdownCommand;

interface Execution {
  request: FakeProviderRequest;
  steps: FakeProviderStep[];
  index: number;
  terminal: boolean;
  safeWait: boolean;
  pendingPullId: number | undefined;
}

const executions = new Map<string, Execution>();
const terminalExecutions = new Set<string>();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function eventFor(executionId: string, step: FakeProviderStep): unknown {
  if (step.kind === "session") {
    return {
      event: "session_bound",
      execution_id: executionId,
      provider_session_id: step.provider_session_id,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "turn") {
    return {
      event: "turn_bound",
      execution_id: executionId,
      provider_turn_id: step.provider_turn_id,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "progress") {
    return {
      event: "progress",
      execution_id: executionId,
      text: step.text,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "approval_required") {
    return {
      event: "approval_required",
      execution_id: executionId,
      approval_request_id: step.approval_request_id,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "approval_resolved") {
    return {
      event: "approval_resolved",
      execution_id: executionId,
      approval_request_id: step.approval_request_id,
      decision: step.decision,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "reply") {
    return {
      event: "reply",
      execution_id: executionId,
      text: step.text,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "no_reply") {
    return {
      event: "completed_without_reply",
      execution_id: executionId,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "unsupported") {
    return {
      event: "unsupported",
      execution_id: executionId,
      reason_code: step.reason_code,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "failed") {
    return {
      event: "failed",
      execution_id: executionId,
      reason_code: step.reason_code,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "cancelled") {
    return {
      event: "cancelled",
      execution_id: executionId,
      reason_code: step.reason_code,
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "uncertain") {
    return {
      event: "uncertain",
      execution_id: executionId,
      reason_code: "provider_outcome_unknown",
    } satisfies FakeProviderEvent;
  }
  if (step.kind === "malformed") return step.value;
  if (step.kind === "oversized") {
    return { event: step.event, execution_id: executionId, text: "x".repeat(step.text_bytes) };
  }
  return undefined;
}

function isTerminal(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = (value as { event?: unknown }).event;
  return (
    event === "reply" ||
    event === "completed_without_reply" ||
    event === "unsupported" ||
    event === "failed" ||
    event === "cancelled" ||
    event === "uncertain"
  );
}

function invoke(command: InvokeCommand): void {
  if (executions.size >= 2 || executions.has(command.request.execution_id)) {
    write({ channel: "protocol_error", code: "execution_capacity" });
    return;
  }
  executions.set(command.request.execution_id, {
    request: command.request,
    steps: command.script,
    index: 0,
    terminal: false,
    safeWait: false,
    pendingPullId: undefined,
  });
}

function pull(command: PullCommand): void {
  const execution = executions.get(command.execution_id);
  if (execution === undefined || execution.pendingPullId !== undefined) {
    write({ channel: "protocol_error", code: "pull_invalid" });
    return;
  }
  if (execution.terminal) {
    executions.delete(command.execution_id);
    write({ channel: "pull_result", request_id: command.request_id, done: true });
    return;
  }
  const step = execution.steps[execution.index];
  if (step === undefined || step.kind === "close") {
    executions.delete(command.execution_id);
    write({ channel: "pull_result", request_id: command.request_id, done: true });
    return;
  }
  execution.index += 1;
  if (step.kind === "wait_for_cancel") {
    execution.safeWait = true;
    execution.pendingPullId = command.request_id;
    return;
  }
  if (step.kind === "crash") process.exit(step.exit_code);
  const value = eventFor(command.execution_id, step);
  execution.terminal = isTerminal(value);
  write({
    channel: "pull_result",
    request_id: command.request_id,
    done: false,
    terminal: execution.terminal,
    value,
  });
  if (execution.terminal) {
    executions.delete(command.execution_id);
    terminalExecutions.add(command.execution_id);
  }
}

function cancel(command: CancelCommand): void {
  const execution = executions.get(command.request.execution_id);
  if (execution === undefined) {
    if (terminalExecutions.has(command.request.execution_id)) {
      write({
        channel: "cancel_result",
        request_id: command.request_id,
        value: { status: "already_terminal" },
      });
      return;
    }
    write({
      channel: "cancel_result",
      request_id: command.request_id,
      value: { status: "not_found" },
    });
    return;
  }
  write({
    channel: "cancel_result",
    request_id: command.request_id,
    value: { status: "cancel_requested" },
  });
  if (!execution.safeWait || execution.pendingPullId === undefined) return;
  const value = {
    event: "cancelled",
    execution_id: execution.request.execution_id,
    reason_code: "cancelled_during_safe_wait",
  } satisfies FakeProviderEvent;
  write({
    channel: "pull_result",
    request_id: execution.pendingPullId,
    done: false,
    terminal: true,
    value,
  });
  execution.pendingPullId = undefined;
  execution.safeWait = false;
  execution.terminal = true;
  executions.delete(command.request.execution_id);
  terminalExecutions.add(command.request.execution_id);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch {
    write({ channel: "protocol_error", code: "command_invalid" });
    return;
  }
  if (command.command === "invoke") invoke(command);
  else if (command.command === "pull") pull(command);
  else if (command.command === "cancel") cancel(command);
  else if (command.command === "shutdown") process.exit(0);
  else write({ channel: "protocol_error", code: "command_invalid" });
});
