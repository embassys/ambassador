import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  type K02ProviderStep,
  type K02Scenario,
  k02Message,
  ManualK02Clock,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

type K02DeliveryOperation =
  | "reply_message"
  | "complete_message"
  | "get_message_outcome"
  | "ack_message";

function assertBlockedClass(scenario: K02Scenario, expected: string): void {
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    assert.equal(
      database.prepare<[], { blocked_class: string }>("SELECT blocked_class FROM messages").get()
        ?.blocked_class,
      expected,
    );
  } finally {
    database.close();
  }
}

function readRetrySchedule(scenario: K02Scenario):
  | {
      retry_kind: string | null;
      retry_not_before_ms: number | null;
    }
  | undefined {
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    return database
      .prepare<[], { retry_kind: string | null; retry_not_before_ms: number | null }>(
        "SELECT retry_kind, retry_not_before_ms FROM messages",
      )
      .get();
  } finally {
    database.close();
  }
}

async function waitForRetrySchedule(
  scenario: K02Scenario,
  retryKind: string,
  retryNotBeforeMs: number,
  label: string,
): Promise<void> {
  await waitFor(() => {
    try {
      const schedule = readRetrySchedule(scenario);
      return (
        schedule?.retry_kind === retryKind && schedule.retry_not_before_ms === retryNotBeforeMs
      );
    } catch {
      return false;
    }
  }, label);
}

function simulateCrashAfterDurableAttemptClaim(
  scenario: K02Scenario,
  retryKind: "reply" | "complete",
): void {
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"));
  try {
    const result = database
      .prepare(
        "UPDATE messages SET retry_kind=?, retry_not_before_ms=NULL, retry_attempt_count=MAX(retry_attempt_count, 1)",
      )
      .run(retryKind);
    assert.equal(result.changes, 1);
  } finally {
    database.close();
  }
}

function deliveryScript(
  operation: K02DeliveryOperation,
  suffix: string,
): readonly K02ProviderStep[] {
  if (operation === "complete_message") {
    return [{ kind: "failed", reason_code: "provider_start_failed" }];
  }
  return [
    { kind: "session", provider_session_id: `${suffix}_session` },
    { kind: "turn", provider_turn_id: `${suffix}_turn` },
    { kind: "reply", text: `${suffix}_reply_bytes` },
  ];
}

function retryKindFor(operation: K02DeliveryOperation): string {
  if (operation === "reply_message") return "reply";
  if (operation === "complete_message") return "complete";
  if (operation === "get_message_outcome") return "outcome_lookup";
  return "ack";
}

test("K02-O01 sends every exact terminal mapping before one acknowledgement", async (t) => {
  const vectors = [
    {
      step: { kind: "reply", text: "ordered reply" },
      bound: true,
      outcome: "replied",
      reason: null,
    },
    {
      step: { kind: "no_reply" },
      bound: true,
      outcome: "completed_without_reply",
      reason: "no_reply_required",
    },
    {
      step: { kind: "unsupported", reason_code: "unsupported_message_type" },
      bound: false,
      outcome: "unsupported",
      reason: "unsupported_message_type",
    },
    {
      step: { kind: "unsupported", reason_code: "unsupported_payload" },
      bound: false,
      outcome: "unsupported",
      reason: "unsupported_payload",
    },
    {
      step: { kind: "failed", reason_code: "provider_start_failed" },
      bound: false,
      outcome: "failed",
      reason: "provider_start_failed",
    },
    {
      step: { kind: "failed", reason_code: "provider_execution_failed" },
      bound: true,
      outcome: "failed",
      reason: "provider_execution_failed",
    },
    {
      step: { kind: "failed", reason_code: "provider_result_invalid" },
      bound: true,
      outcome: "failed",
      reason: "provider_result_invalid",
    },
    {
      step: { kind: "cancelled", reason_code: "cancelled_before_execution" },
      bound: false,
      outcome: "cancelled",
      reason: "cancelled_before_execution",
    },
    {
      step: { kind: "uncertain" },
      bound: true,
      outcome: "uncertain",
      reason: "provider_outcome_unknown",
    },
  ] as const;
  for (const [index, vector] of vectors.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:O01", {
      gatewayProxy: true,
      scripts: [
        [
          ...(vector.bound
            ? ([
                { kind: "session", provider_session_id: `session_order_${index}` },
                { kind: "turn", provider_turn_id: `turn_order_${index}` },
              ] as const)
            : []),
          vector.step,
        ],
      ],
    });
    const message = k02Message(`message_order_${index}`, `conversation_order_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await scenario.connector.waitForIdle();
    assert.deepEqual(
      scenario.gateway.calls.map((call) => call.name),
      [
        "poll_messages",
        vector.outcome === "replied" ? "reply_message" : "complete_message",
        "ack_message",
      ],
    );
    if (vector.outcome !== "replied") {
      assert.deepEqual(scenario.gateway.calls[1]?.arguments, {
        message_id: message.id,
        outcome: vector.outcome,
        reason_code: vector.reason,
      });
    } else {
      assert.deepEqual(
        scenario.gatewayProxy?.calls.find((call) => call.tool === "reply_message")?.arguments,
        { message_id: message.id, payload: { text: vector.step.text } },
      );
    }
    assert.equal(scenario.gateway.tombstone(message.id)?.outcome, vector.outcome);
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  }

  const invalidPostDispatch = [
    { kind: "unsupported", reason_code: "unsupported_message_type" },
    { kind: "failed", reason_code: "provider_start_failed" },
    { kind: "cancelled", reason_code: "cancelled_before_execution" },
    { kind: "unsupported", reason_code: "unsupported_payload" },
  ] satisfies readonly K02ProviderStep[];
  for (const [index, invalid] of invalidPostDispatch.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:O01", {
      scripts: [
        [
          { kind: "session", provider_session_id: `invalid_terminal_session_${index}` },
          { kind: "turn", provider_turn_id: `invalid_terminal_turn_${index}` },
          invalid,
        ],
      ],
    });
    const message = k02Message(
      `invalid_terminal_${index}`,
      `invalid_terminal_conversation_${index}`,
    );
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.provider.cancellations[0]?.reason, "contract_failure");
    assert.deepEqual(scenario.gateway.calls.at(-2)?.arguments, {
      message_id: message.id,
      outcome: "uncertain",
      reason_code: "provider_outcome_unknown",
    });
  }

  const clock = new ManualK02Clock(1_788_350_000_000);
  const safeWait = await startK02Scenario(t, "K02-K03:O01", {
    clock,
    scripts: [
      [
        { kind: "session", provider_session_id: "o01_safe_wait_session" },
        { kind: "turn", provider_turn_id: "o01_safe_wait_turn" },
        { kind: "approval_required", approval_request_id: "o01_safe_wait_approval" },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const safeWaitMessage = k02Message("o01_safe_wait", "o01_safe_wait_conversation");
  safeWait.enqueue(safeWaitMessage);
  assert.equal(
    (await safeWait.wake(safeWaitMessage.id, Math.floor(clock.nowMs() / 1_000))).status,
    202,
  );
  await waitFor(() => safeWait.provider.pulls.length === 4, "O01 safe approval wait");
  clock.advance(900_000);
  await safeWait.connector.waitForIdle();
  assert.deepEqual(
    safeWait.gateway.calls.map((call) => call.name),
    ["poll_messages", "complete_message", "ack_message"],
  );
  assert.deepEqual(safeWait.gateway.calls[1]?.arguments, {
    message_id: safeWaitMessage.id,
    outcome: "cancelled",
    reason_code: "cancelled_during_safe_wait",
  });
  assert.deepEqual(safeWait.gateway.tombstone(safeWaitMessage.id), {
    message_id: safeWaitMessage.id,
    conversation_id: safeWaitMessage.conversation_id,
    outcome: "cancelled",
    reply_message_id: null,
    acknowledged: true,
  });
});

test("K02-O02 maps an unrecoverable provider result to uncertain without redispatch", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:O02", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_uncertain" },
        { kind: "turn", provider_turn_id: "turn_uncertain" },
        { kind: "uncertain" },
      ],
    ],
  });
  const message = k02Message("message_uncertain", "conversation_uncertain");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();

  assert.equal(scenario.provider.requests.length, 1);
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "complete_message", "ack_message"],
  );
  assert.deepEqual(scenario.gateway.calls[1]?.arguments, {
    message_id: message.id,
    outcome: "uncertain",
    reason_code: "provider_outcome_unknown",
  });
});

test("K02-C02 recovers only the exact durable turn after a crash", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:C02", {
    crashAfter: "provider_terminal_received",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_recovery" },
        { kind: "turn", provider_turn_id: "turn_recovery" },
        { kind: "reply", text: "recoverable reply" },
      ],
    ],
  });
  const message = k02Message("message_recovery", "conversation_recovery");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_test_crash/u);
  await scenario.connector.crash();

  const restarted = await scenario.restart([
    [
      { kind: "progress", text: "recovered exact turn" },
      { kind: "reply", text: "recoverable reply" },
    ],
  ]);
  await restarted.connector.waitForIdle();
  assert.equal(restarted.provider.requests.length, 1);
  const recovery = restarted.provider.requests[0];
  assert.equal(recovery?.kind, "recover");
  if (recovery?.kind === "recover") {
    assert.equal(recovery.provider_session_id, "session_recovery");
    assert.equal(recovery.provider_turn_id, "turn_recovery");
    assert.ok(!("input_text" in recovery));
  }
  assert.equal(scenario.provider.requests.length, 1);
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "reply_message", "ack_message"],
  );

  const sessionOnly = await startK02Scenario(t, "K02-K03:C02", {
    crashForRecoveryState: "session_binding",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_recovery_without_turn" },
        { kind: "turn", provider_turn_id: "unread_turn" },
      ],
    ],
  });
  const sessionOnlyMessage = k02Message(
    "message_session_only_recovery",
    "conversation_session_only_recovery",
  );
  sessionOnly.enqueue(sessionOnlyMessage);
  assert.equal((await sessionOnly.wake(sessionOnlyMessage.id)).status, 202);
  await assert.rejects(sessionOnly.connector.waitForIdle(), /connector_test_crash/u);
  assert.equal(sessionOnly.provider.pulls.length, 1);
  await sessionOnly.connector.crash();
  const sessionOnlyRestart = await sessionOnly.restart([
    [
      { kind: "turn", provider_turn_id: "qualified_recovery_turn" },
      { kind: "reply", text: "session-only recovery reply" },
    ],
  ]);
  await sessionOnlyRestart.connector.waitForIdle();
  const sessionOnlyRequest = sessionOnlyRestart.provider.requests[0];
  assert.equal(sessionOnlyRequest?.kind, "recover");
  if (sessionOnlyRequest?.kind === "recover") {
    assert.equal(sessionOnlyRequest.provider_session_id, "session_recovery_without_turn");
    assert.equal(sessionOnlyRequest.provider_turn_id, null);
    assert.ok(!("input_text" in sessionOnlyRequest));
  }
  assert.equal(sessionOnlyRestart.provider.requests.length, 1);
  assert.deepEqual(
    sessionOnly.gateway.calls.map((call) => call.name),
    ["poll_messages", "reply_message", "ack_message"],
  );
});

test("K02-C01 resolves a committed lost reply through outcome lookup and one ack", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:C01", {
    crashAfter: "reply_committed_unobserved",
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_commit" },
        { kind: "turn", provider_turn_id: "turn_commit" },
        { kind: "reply", text: "idempotent reply" },
      ],
    ],
  });
  const message = k02Message("message_commit", "conversation_commit");
  scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_test_crash/u);
  await scenario.connector.crash();
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "reply_message"],
  );

  const restarted = await scenario.restart([]);
  await restarted.connector.waitForIdle();
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "reply_message", "get_message_outcome", "ack_message"],
  );
  assert.equal(restarted.provider.requests.length, 0);
  assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);

  const claimedTerminalClock = new ManualK02Clock(1_788_400_000_000);
  const claimedTerminal = await startK02Scenario(t, "K02-K03:C01", {
    clock: claimedTerminalClock,
    crashAfter: "reply_accepted",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_claimed_terminal" },
        { kind: "turn", provider_turn_id: "turn_claimed_terminal" },
        { kind: "reply", text: "claimed terminal reply" },
      ],
    ],
  });
  const claimedTerminalMessage = k02Message(
    "message_claimed_terminal",
    "conversation_claimed_terminal",
  );
  claimedTerminal.enqueue(claimedTerminalMessage);
  assert.equal(
    (
      await claimedTerminal.wake(
        claimedTerminalMessage.id,
        Math.floor(claimedTerminalClock.nowMs() / 1_000),
      )
    ).status,
    202,
  );
  await assert.rejects(claimedTerminal.connector.waitForIdle(), /connector_test_crash/u);
  await claimedTerminal.connector.crash();
  simulateCrashAfterDurableAttemptClaim(claimedTerminal, "reply");
  const claimedTerminalRestart = await claimedTerminal.restart([]);
  try {
    await waitFor(
      () => claimedTerminal.gateway.calls.length >= 3,
      "recovered claimed reply outcome lookup",
    );
    assert.equal(
      claimedTerminal.gateway.calls[2]?.name,
      "get_message_outcome",
      "recovery repeated a claimed reply before resolving its outcome",
    );
    await claimedTerminalRestart.connector.waitForIdle();
    assert.deepEqual(
      claimedTerminal.gateway.calls.map((call) => call.name),
      ["poll_messages", "reply_message", "get_message_outcome", "ack_message"],
    );
  } finally {
    await claimedTerminalRestart.connector.close();
  }

  const openCompletionClock = new ManualK02Clock(1_788_410_000_000);
  const openCompletion = await startK02Scenario(t, "K02-K03:C01", {
    clock: openCompletionClock,
    gatewayProxy: true,
    scripts: [[{ kind: "failed", reason_code: "provider_start_failed" }]],
  });
  openCompletion.gatewayProxy?.failNext("complete_message", { kind: "drop_before_dispatch" });
  const openCompletionMessage = k02Message(
    "message_claimed_open_completion",
    "conversation_claimed_open_completion",
  );
  openCompletion.enqueue(openCompletionMessage);
  assert.equal(
    (
      await openCompletion.wake(
        openCompletionMessage.id,
        Math.floor(openCompletionClock.nowMs() / 1_000),
      )
    ).status,
    202,
  );
  await waitForRetrySchedule(
    openCompletion,
    "outcome_lookup",
    openCompletionClock.nowMs() + 30_000,
    "claimed open completion outcome schedule",
  );
  await openCompletion.connector.crash();
  simulateCrashAfterDurableAttemptClaim(openCompletion, "complete");
  const openCompletionRestart = await openCompletion.restart([]);
  try {
    await waitFor(
      () => openCompletion.gateway.calls.length >= 2,
      "recovered claimed completion outcome lookup",
    );
    assert.equal(
      openCompletion.gateway.calls[1]?.name,
      "get_message_outcome",
      "recovery repeated a claimed completion before resolving its outcome",
    );
    await openCompletionRestart.connector.waitForIdle();
    assert.deepEqual(
      openCompletion.gateway.calls.map((call) => call.name),
      ["poll_messages", "get_message_outcome", "complete_message", "ack_message"],
    );
  } finally {
    await openCompletionRestart.connector.close();
  }
});

test("K02-P07 blocks terminal reporting when qualified containment cannot prove cleanup", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:P07", {
    contained: false,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_cleanup" },
        { kind: "turn", provider_turn_id: "turn_cleanup" },
        { kind: "oversized", event: "reply", text_bytes: 262_145 },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const message = k02Message("message_cleanup", "conversation_cleanup");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_provider_cleanup_incomplete/u);
  await waitFor(() => scenario.providerPort.containmentAttempts === 1, "containment attempt");
  assert.equal(scenario.provider.cancellations[0]?.reason, "output_limit");
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages"],
  );
  assert.equal(scenario.gateway.tombstone(message.id), undefined);
});

test("K02-O03 converts a lost open reply to uncertain after exact recovery cannot restore bytes", async (t) => {
  const clock = new ManualK02Clock(1_788_000_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:O03", {
    clock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_lost_open" },
        { kind: "turn", provider_turn_id: "turn_lost_open" },
        { kind: "reply", text: "reply lost before dispatch" },
      ],
      [{ kind: "uncertain" }],
    ],
  });
  scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
  const message = k02Message("o03_message", "o03_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await waitFor(
    () => scenario.gateway.calls.filter((call) => call.name === "poll_messages").length === 1,
    "initial poll",
  );
  await waitForRetrySchedule(
    scenario,
    "outcome_lookup",
    clock.nowMs() + 30_000,
    "lost-open outcome schedule",
  );
  clock.advance(30_000);
  await scenario.connector.waitForIdle();
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "get_message_outcome", "complete_message", "ack_message"],
  );
  assert.deepEqual(scenario.gateway.calls.at(-2)?.arguments, {
    message_id: message.id,
    outcome: "uncertain",
    reason_code: "provider_outcome_unknown",
  });
  assert.deepEqual(
    scenario.provider.requests.map((request) => request.kind),
    ["start", "recover"],
  );

  const claimedClock = new ManualK02Clock(1_788_430_000_000);
  const claimed = await startK02Scenario(t, "K02-K03:O03", {
    clock: claimedClock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_claimed_open_reply" },
        { kind: "turn", provider_turn_id: "turn_claimed_open_reply" },
        { kind: "reply", text: "exact claimed open reply" },
      ],
    ],
  });
  claimed.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
  const claimedMessage = k02Message(
    "message_claimed_open_reply",
    "conversation_claimed_open_reply",
  );
  claimed.enqueue(claimedMessage);
  assert.equal(
    (await claimed.wake(claimedMessage.id, Math.floor(claimedClock.nowMs() / 1_000))).status,
    202,
  );
  await waitForRetrySchedule(
    claimed,
    "outcome_lookup",
    claimedClock.nowMs() + 30_000,
    "claimed open reply outcome schedule",
  );
  await claimed.connector.crash();
  simulateCrashAfterDurableAttemptClaim(claimed, "reply");
  const claimedRestart = await claimed.restart([
    [
      { kind: "progress", text: "recovering claimed open reply" },
      { kind: "reply", text: "exact claimed open reply" },
    ],
  ]);
  try {
    await claimedRestart.connector.waitForIdle();
    assert.deepEqual(
      claimed.gateway.calls.map((call) => call.name),
      ["poll_messages", "get_message_outcome", "reply_message", "ack_message"],
      "lost reply recovery did not resolve open state before exact-turn recovery",
    );
    assert.deepEqual(
      claimedRestart.provider.requests.map((request) => request.kind),
      ["recover"],
    );
    assert.equal(claimed.gateway.tombstone(claimedMessage.id)?.outcome, "replied");
  } finally {
    await claimedRestart.connector.close();
  }
});

test("K02-O04 retains one mailbox-full reply in memory and retries no provider turn", async (t) => {
  const clock = new ManualK02Clock(1_788_000_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:O04", {
    clock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_mailbox" },
        { kind: "turn", provider_turn_id: "turn_mailbox" },
        { kind: "reply", text: "mailbox retry bytes" },
      ],
    ],
  });
  scenario.gatewayProxy?.failNext("reply_message", {
    kind: "application_error",
    code: "mailbox_full",
  });
  const message = k02Message("o04_message", "o04_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await waitFor(
    () => scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length === 1,
    "mailbox-full reply",
  );
  assert.equal(scenario.gateway.tombstone(message.id), undefined);
  clock.advance(29_999);
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length,
    1,
  );
  clock.advance(1);
  await scenario.connector.waitForIdle();
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length,
    2,
  );
  const replyCalls = scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message");
  assert.deepEqual(replyCalls?.[0]?.arguments, {
    message_id: message.id,
    payload: { text: "mailbox retry bytes" },
  });
  assert.deepEqual(replyCalls?.[1]?.arguments, replyCalls?.[0]?.arguments);
  assert.equal(scenario.provider.requests.length, 1);
  assert.equal(scenario.gateway.tombstone(message.id)?.outcome, "replied");
});

test("K02-O05 follows one 1,2,4,8,16,30-second lifetime retry schedule", async (t) => {
  const clock = new ManualK02Clock(1_788_000_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:O05", {
    clock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_backoff" },
        { kind: "turn", provider_turn_id: "turn_backoff" },
        { kind: "no_reply" },
      ],
    ],
  });
  for (let index = 0; index < 255; index += 1) {
    scenario.gatewayProxy?.failNext("complete_message", {
      kind: "application_error",
      code: "temporarily_unavailable",
    });
  }
  const message = k02Message("o05_message", "o05_conversation");
  let lastWakeTimestamp = Math.floor(clock.nowMs() / 1_000) - 1;
  const sendDistinctWake = async (): Promise<Response> => {
    lastWakeTimestamp = Math.max(Math.floor(clock.nowMs() / 1_000), lastWakeTimestamp + 1);
    return await scenario.wake(message.id, lastWakeTimestamp);
  };
  scenario.enqueue(message);
  assert.equal((await sendDistinctWake()).status, 202);
  await waitFor(
    () =>
      scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length === 1,
    "first central attempt",
  );
  await waitForRetrySchedule(
    scenario,
    "complete",
    clock.nowMs() + 1_000,
    "first central retry schedule",
  );
  clock.advance(999);
  assert.equal((await sendDistinctWake()).status, 202);
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    1,
  );
  await scenario.connector.crash();
  let restarted = await scenario.restart([]);
  assert.equal(restarted.provider.requests.length, 0);
  assert.equal((await sendDistinctWake()).status, 202);
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    1,
  );
  clock.advance(1);

  for (let attempt = 2; attempt <= 255; attempt += 1) {
    await waitFor(
      () =>
        scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length ===
        attempt,
      `central attempt ${attempt}`,
    );
    const delay =
      attempt === 2
        ? 2_000
        : attempt === 3
          ? 4_000
          : attempt === 4
            ? 8_000
            : attempt === 5
              ? 16_000
              : 30_000;
    await waitForRetrySchedule(
      scenario,
      "complete",
      clock.nowMs() + delay,
      `central retry schedule ${attempt}`,
    );
    if (attempt < 255) {
      clock.advance(delay - 1);
      assert.equal((await sendDistinctWake()).status, 202);
      assert.equal(
        scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
        attempt,
      );
      clock.advance(1);
    }
  }

  const Database = (await import("better-sqlite3")).default;
  const { join } = await import("node:path");
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      database
        .prepare<[], { retry_attempt_count: number; retry_not_before_ms: number }>(
          "SELECT retry_attempt_count, retry_not_before_ms FROM messages",
        )
        .get(),
      { retry_attempt_count: 255, retry_not_before_ms: clock.nowMs() + 30_000 },
    );
  } finally {
    database.close();
  }
  clock.advance(29_999);
  assert.equal((await sendDistinctWake()).status, 202);
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    255,
  );
  await restarted.connector.crash();
  restarted = await scenario.restart([]);
  assert.equal(restarted.provider.requests.length, 0);
  clock.advance(1);
  await restarted.connector.waitForIdle();
  assert.equal(
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    256,
  );
  assert.equal(scenario.provider.requests.length, 1);
});

test("K02-O06 blocks every permanent, authentication, and malformed gateway result", async (t) => {
  const vectors = [
    { code: "invalid_request", blockedClass: "permanent_application" },
    { code: "recipient_unavailable", blockedClass: "permanent_application" },
    { code: "message_not_found", blockedClass: "permanent_application" },
    { code: "idempotency_conflict", blockedClass: "permanent_application" },
    { code: "receive_in_progress", blockedClass: "permanent_application" },
    { code: "protocol_mismatch", blockedClass: "permanent_application" },
    { code: "request_too_large", blockedClass: "permanent_application" },
    { code: "migration_incomplete", blockedClass: "contract" },
    { code: "authentication_failed", blockedClass: "authentication" },
    { code: "unknown_code", blockedClass: "contract" },
  ];
  const deliveryOperations = [
    "reply_message",
    "complete_message",
    "get_message_outcome",
    "ack_message",
  ] as const;
  for (const [codeIndex, vector] of vectors.entries()) {
    for (const [operationIndex, operation] of deliveryOperations.entries()) {
      const suffix = `o06_class_${codeIndex}_${operationIndex}`;
      const clock = new ManualK02Clock(1_789_100_000_000 + codeIndex * 100_000);
      const scenario = await startK02Scenario(t, "K02-K03:O06", {
        clock,
        gatewayProxy: true,
        scripts: [[...deliveryScript(operation, suffix)]],
      });
      if (operation === "get_message_outcome") {
        scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
      }
      scenario.gatewayProxy?.failNext(operation, {
        kind: "application_error",
        code: vector.code,
      });
      const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
      scenario.enqueue(message);
      assert.equal(
        (await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status,
        202,
      );
      if (operation === "get_message_outcome") {
        await waitFor(
          () =>
            scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length ===
            1,
          `${suffix} lost reply`,
        );
        await waitForRetrySchedule(
          scenario,
          "outcome_lookup",
          clock.nowMs() + 30_000,
          `${suffix} outcome schedule`,
        );
        clock.advance(30_000);
      }
      await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
      assertBlockedClass(scenario, vector.blockedClass);
      assert.equal(
        scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length,
        1,
      );
      assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged ?? false, false);
      assert.equal(scenario.provider.requests.length, 1);
    }
  }

  for (const [operationIndex, operation] of deliveryOperations.entries()) {
    const suffix = `o06_rate_${operationIndex}`;
    const clock = new ManualK02Clock(1_789_200_000_000 + operationIndex * 100_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [[...deliveryScript(operation, suffix)]],
    });
    if (operation === "get_message_outcome") {
      scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
    }
    scenario.gatewayProxy?.failNext(operation, {
      kind: "application_error",
      code: "rate_limited",
      retryAfterMs: 60_000,
    });
    const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    if (operation === "get_message_outcome") {
      await waitFor(
        () =>
          scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length === 1,
        `${suffix} lost reply`,
      );
      await waitForRetrySchedule(
        scenario,
        "outcome_lookup",
        clock.nowMs() + 30_000,
        `${suffix} outcome schedule`,
      );
      clock.advance(30_000);
    }
    await waitFor(
      () => scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length === 1,
      `${suffix} first rate-limited operation`,
    );
    await waitForRetrySchedule(
      scenario,
      retryKindFor(operation),
      clock.nowMs() + 60_000,
      `${suffix} rate-limit schedule`,
    );
    clock.advance(59_999);
    assert.equal(scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length, 1);
    clock.advance(1);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length, 2);
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
    assert.equal(scenario.provider.requests.length, 1);
  }

  const invalidRetryAfterValues: readonly unknown[] = [undefined, "1000", 0, 60_001];
  for (const [operationIndex, operation] of deliveryOperations.entries()) {
    for (const [delayIndex, retryAfterMs] of invalidRetryAfterValues.entries()) {
      const suffix = `o06_invalid_retry_${operationIndex}_${delayIndex}`;
      const clock = new ManualK02Clock(1_789_225_000_000 + operationIndex * 100_000);
      const scenario = await startK02Scenario(t, "K02-K03:O06", {
        clock,
        gatewayProxy: true,
        scripts: [[...deliveryScript(operation, suffix)]],
      });
      if (operation === "get_message_outcome") {
        scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
      }
      scenario.gatewayProxy?.failNext(operation, {
        kind: "application_error",
        code: "rate_limited",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
      const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
      scenario.enqueue(message);
      assert.equal(
        (await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status,
        202,
      );
      if (operation === "get_message_outcome") {
        await waitFor(
          () =>
            scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length ===
            1,
          `${suffix} lost reply`,
        );
        await waitForRetrySchedule(
          scenario,
          "outcome_lookup",
          clock.nowMs() + 30_000,
          `${suffix} outcome schedule`,
        );
        clock.advance(30_000);
      }
      await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
      assertBlockedClass(scenario, "contract");
      assert.equal(
        scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length,
        1,
      );
      assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged ?? false, false);
    }
  }

  const baseDelayClock = new ManualK02Clock(1_789_240_000_000);
  const baseDelay = await startK02Scenario(t, "K02-K03:O06", {
    clock: baseDelayClock,
    gatewayProxy: true,
    scripts: [[{ kind: "failed", reason_code: "provider_start_failed" }]],
  });
  baseDelay.gatewayProxy?.failNext("complete_message", {
    kind: "application_error",
    code: "rate_limited",
    retryAfterMs: 500,
  });
  const baseDelayMessage = k02Message("o06_base_delay", "o06_base_delay_conversation");
  baseDelay.enqueue(baseDelayMessage);
  assert.equal(
    (await baseDelay.wake(baseDelayMessage.id, Math.floor(baseDelayClock.nowMs() / 1_000))).status,
    202,
  );
  await waitFor(
    () =>
      baseDelay.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length === 1,
    "rate limit below base delay",
  );
  await waitForRetrySchedule(
    baseDelay,
    "complete",
    baseDelayClock.nowMs() + 1_000,
    "rate-limit base schedule",
  );
  baseDelayClock.advance(999);
  assert.equal(
    baseDelay.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    1,
  );
  baseDelayClock.advance(1);
  await baseDelay.connector.waitForIdle();
  assert.equal(
    baseDelay.gatewayProxy?.calls.filter((call) => call.tool === "complete_message").length,
    2,
  );

  for (const [operationIndex, operation] of deliveryOperations.entries()) {
    const suffix = `o06_temporary_${operationIndex}`;
    const clock = new ManualK02Clock(1_789_250_000_000 + operationIndex * 100_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [[...deliveryScript(operation, suffix)]],
    });
    if (operation === "get_message_outcome") {
      scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
    }
    scenario.gatewayProxy?.failNext(operation, {
      kind: "application_error",
      code: "temporarily_unavailable",
    });
    const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    if (operation === "get_message_outcome") {
      await waitFor(
        () =>
          scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length === 1,
        `${suffix} lost reply`,
      );
      await waitForRetrySchedule(
        scenario,
        "outcome_lookup",
        clock.nowMs() + 30_000,
        `${suffix} outcome schedule`,
      );
      clock.advance(30_000);
    }
    await waitFor(
      () => scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length === 1,
      `${suffix} first temporary failure`,
    );
    const delay =
      operation === "get_message_outcome" ? 30_000 : operation === "ack_message" ? 2_000 : 1_000;
    await waitForRetrySchedule(
      scenario,
      retryKindFor(operation),
      clock.nowMs() + delay,
      `${suffix} temporary schedule`,
    );
    clock.advance(delay - 1);
    assert.equal(scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length, 1);
    clock.advance(1);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length, 2);
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
    assert.equal(scenario.provider.requests.length, 1);
  }

  const alreadyTerminalOperations = ["reply_message", "complete_message"] as const;
  for (const [operationIndex, operation] of alreadyTerminalOperations.entries()) {
    const suffix = `o06_already_terminal_${operationIndex}`;
    const clock = new ManualK02Clock(1_789_300_000_000 + operationIndex * 100_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [[...deliveryScript(operation, suffix)]],
    });
    scenario.gatewayProxy?.failNext(operation, {
      kind: "application_error",
      code: "message_already_terminal",
    });
    const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    await waitFor(
      () => scenario.gatewayProxy?.calls.filter((call) => call.tool === operation).length === 1,
      `${suffix} ambiguous terminal response`,
    );
    await waitForRetrySchedule(
      scenario,
      "outcome_lookup",
      clock.nowMs() + 30_000,
      `${suffix} already-terminal schedule`,
    );
    clock.advance(29_999);
    assert.equal(
      scenario.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome").length,
      0,
    );
    clock.advance(1);
    await scenario.connector.waitForIdle();
    assert.deepEqual(
      scenario.gatewayProxy?.calls
        .filter((call) => call.tool !== undefined)
        .map((call) => call.tool),
      ["poll_messages", operation, "get_message_outcome", operation, "ack_message"],
    );
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
    assert.equal(scenario.provider.requests.length, 1);
  }

  const invalidOperationResults: readonly {
    operation: K02DeliveryOperation;
    code: "mailbox_full" | "message_already_terminal" | "message_not_terminal";
  }[] = [
    { operation: "reply_message", code: "message_not_terminal" },
    { operation: "complete_message", code: "message_not_terminal" },
    { operation: "complete_message", code: "mailbox_full" },
    { operation: "get_message_outcome", code: "message_already_terminal" },
    { operation: "get_message_outcome", code: "message_not_terminal" },
    { operation: "get_message_outcome", code: "mailbox_full" },
    { operation: "ack_message", code: "message_already_terminal" },
    { operation: "ack_message", code: "message_not_terminal" },
    { operation: "ack_message", code: "mailbox_full" },
  ];
  for (const [index, vector] of invalidOperationResults.entries()) {
    const suffix = `o06_invalid_branch_${index}`;
    const clock = new ManualK02Clock(1_789_400_000_000 + index * 100_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [[...deliveryScript(vector.operation, suffix)]],
    });
    if (vector.operation === "get_message_outcome") {
      scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
    }
    scenario.gatewayProxy?.failNext(vector.operation, {
      kind: "application_error",
      code: vector.code,
    });
    const message = k02Message(`${suffix}_message`, `${suffix}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    if (vector.operation === "get_message_outcome") {
      await waitFor(
        () =>
          scenario.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length === 1,
        `${suffix} lost reply`,
      );
      await waitForRetrySchedule(
        scenario,
        "outcome_lookup",
        clock.nowMs() + 30_000,
        `${suffix} outcome schedule`,
      );
      clock.advance(30_000);
    }
    await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
    assertBlockedClass(scenario, "contract");
    assert.equal(
      scenario.gatewayProxy?.calls.filter((call) => call.tool === vector.operation).length,
      1,
    );
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged ?? false, false);
  }

  for (const [suffix, fault] of [
    ["malformed", { kind: "malformed_result" }],
    [
      "identifier_mismatch",
      {
        kind: "structured_result",
        value: { message_id: "wrong_message", outcome: "failed", status: "recorded" },
      },
    ],
  ] as const) {
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      gatewayProxy: true,
      scripts: [[{ kind: "failed", reason_code: "provider_start_failed" }]],
    });
    scenario.gatewayProxy?.failNext("complete_message", fault);
    const message = k02Message(`o06_${suffix}`, `o06_${suffix}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await assert.rejects(
      scenario.connector.waitForIdle(),
      /connector_gateway_operation_failed/u,
      `${suffix} gateway result must fail closed`,
    );
    const Database = (await import("better-sqlite3")).default;
    const { join } = await import("node:path");
    const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
      readonly: true,
    });
    try {
      assert.equal(
        database.prepare<[], { blocked_class: string }>("SELECT blocked_class FROM messages").get()
          ?.blocked_class,
        "contract",
      );
    } finally {
      database.close();
    }
    assert.equal(scenario.gateway.tombstone(message.id), undefined);
  }

  for (const operation of ["poll_messages", "reply_message", "ack_message"] as const) {
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      gatewayProxy: true,
      scripts: [
        [
          { kind: "session", provider_session_id: `o06_${operation}_session` },
          { kind: "turn", provider_turn_id: `o06_${operation}_turn` },
          { kind: "reply", text: "operation result" },
        ],
      ],
    });
    scenario.gatewayProxy?.failNext(operation, { kind: "malformed_result" });
    const message = k02Message(`o06_${operation}`, `o06_${operation}_conversation`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
    assert.equal(scenario.gateway.tombstone(message.id), undefined);
  }

  const uncertainPoll = await startK02Scenario(t, "K02-K03:O06", {
    gatewayProxy: true,
  });
  uncertainPoll.gatewayProxy?.failNext("poll_messages", { kind: "drop_after_commit" });
  const uncertainPollMessage = k02Message("o06_uncertain_poll", "o06_uncertain_poll_conversation");
  uncertainPoll.enqueue(uncertainPollMessage);
  assert.equal((await uncertainPoll.wake(uncertainPollMessage.id)).status, 202);
  await assert.rejects(
    uncertainPoll.connector.waitForIdle(),
    /connector_gateway_operation_failed/u,
  );
  assert.equal(uncertainPoll.provider.requests.length, 0);
  assert.equal(uncertainPoll.gateway.tombstone(uncertainPollMessage.id), undefined);

  const outcomeClock = new ManualK02Clock(1_788_400_000_000);
  const malformedOutcome = await startK02Scenario(t, "K02-K03:O06", {
    clock: outcomeClock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "o06_outcome_session" },
        { kind: "turn", provider_turn_id: "o06_outcome_turn" },
        { kind: "reply", text: "committed reply" },
      ],
    ],
  });
  malformedOutcome.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
  malformedOutcome.gatewayProxy?.failNext("get_message_outcome", { kind: "malformed_result" });
  const malformedOutcomeMessage = k02Message("o06_outcome", "o06_outcome_conversation");
  malformedOutcome.enqueue(malformedOutcomeMessage);
  assert.equal(
    (
      await malformedOutcome.wake(
        malformedOutcomeMessage.id,
        Math.floor(outcomeClock.nowMs() / 1_000),
      )
    ).status,
    202,
  );
  await waitFor(
    () =>
      malformedOutcome.gatewayProxy?.calls.some((call) => call.tool === "reply_message") ?? false,
    "uncertain reply",
  );
  await waitForRetrySchedule(
    malformedOutcome,
    "outcome_lookup",
    outcomeClock.nowMs() + 30_000,
    "malformed outcome schedule",
  );
  outcomeClock.advance(30_000);
  await assert.rejects(
    malformedOutcome.connector.waitForIdle(),
    /connector_gateway_operation_failed/u,
  );

  const mismatchedClock = new ManualK02Clock(1_788_450_000_000);
  const mismatchedOutcome = await startK02Scenario(t, "K02-K03:O06", {
    clock: mismatchedClock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "o06_mismatch_session" },
        { kind: "turn", provider_turn_id: "o06_mismatch_turn" },
        { kind: "reply", text: "reply whose terminal outcome must match" },
      ],
    ],
  });
  const mismatchedMessage = k02Message(
    "o06_mismatched_terminal",
    "o06_mismatched_terminal_conversation",
  );
  mismatchedOutcome.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
  mismatchedOutcome.gatewayProxy?.failNext("get_message_outcome", {
    kind: "structured_result",
    value: {
      message_id: mismatchedMessage.id,
      conversation_id: mismatchedMessage.conversation_id,
      status: "terminal",
      outcome: "failed",
      reply_message_id: null,
    },
  });
  mismatchedOutcome.enqueue(mismatchedMessage);
  assert.equal(
    (
      await mismatchedOutcome.wake(
        mismatchedMessage.id,
        Math.floor(mismatchedClock.nowMs() / 1_000),
      )
    ).status,
    202,
  );
  await waitFor(
    () =>
      mismatchedOutcome.gatewayProxy?.calls.filter((call) => call.tool === "reply_message")
        .length === 1,
    "same-ID mismatched terminal seed",
  );
  await waitForRetrySchedule(
    mismatchedOutcome,
    "outcome_lookup",
    mismatchedClock.nowMs() + 30_000,
    "mismatched outcome schedule",
  );
  mismatchedClock.advance(30_000);
  await assert.rejects(
    mismatchedOutcome.connector.waitForIdle(),
    /connector_gateway_operation_failed/u,
  );
  assertBlockedClass(mismatchedOutcome, "contract");
  assert.equal(
    mismatchedOutcome.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome")
      .length,
    1,
  );
  assert.equal(
    mismatchedOutcome.gateway.tombstone(mismatchedMessage.id)?.acknowledged ?? false,
    false,
  );

  const outcomeContractVectors = [
    {
      name: "wrong_message_id",
      plan: "reply",
      value(message: ReturnType<typeof k02Message>) {
        return {
          message_id: "wrong_message_id",
          conversation_id: message.conversation_id,
          status: "terminal",
          outcome: "replied",
          reply_message_id: "reply_id",
        };
      },
    },
    {
      name: "wrong_conversation_id",
      plan: "reply",
      value(message: ReturnType<typeof k02Message>) {
        return {
          message_id: message.id,
          conversation_id: "wrong_conversation_id",
          status: "terminal",
          outcome: "replied",
          reply_message_id: "reply_id",
        };
      },
    },
    {
      name: "replied_null_reply_id",
      plan: "reply",
      value(message: ReturnType<typeof k02Message>) {
        return {
          message_id: message.id,
          conversation_id: message.conversation_id,
          status: "terminal",
          outcome: "replied",
          reply_message_id: null,
        };
      },
    },
    {
      name: "completion_nonnull_reply_id",
      plan: "complete",
      value(message: ReturnType<typeof k02Message>) {
        return {
          message_id: message.id,
          conversation_id: message.conversation_id,
          status: "terminal",
          outcome: "failed",
          reply_message_id: "unexpected_reply_id",
        };
      },
    },
  ] as const;
  for (const [index, vector] of outcomeContractVectors.entries()) {
    const clock = new ManualK02Clock(1_788_475_000_000 + index * 100_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [
        vector.plan === "reply"
          ? [
              { kind: "session", provider_session_id: `${vector.name}_session` },
              { kind: "turn", provider_turn_id: `${vector.name}_turn` },
              { kind: "reply", text: `${vector.name}_reply` },
            ]
          : [{ kind: "failed", reason_code: "provider_start_failed" }],
      ],
    });
    const message = k02Message(`o06_${vector.name}`, `o06_${vector.name}_conversation`);
    const sideEffect = vector.plan === "reply" ? "reply_message" : "complete_message";
    scenario.gatewayProxy?.failNext(sideEffect, { kind: "drop_after_commit" });
    scenario.gatewayProxy?.failNext("get_message_outcome", {
      kind: "structured_result",
      value: vector.value(message),
    });
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    await waitFor(
      () => scenario.gatewayProxy?.calls.some((call) => call.tool === sideEffect) ?? false,
      `${vector.name} terminal request`,
    );
    await waitForRetrySchedule(
      scenario,
      "outcome_lookup",
      clock.nowMs() + 30_000,
      `${vector.name} outcome schedule`,
    );
    clock.advance(30_000);
    await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
    assertBlockedClass(scenario, "contract");
    assert.equal(
      scenario.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome").length,
      1,
    );
    assert.equal(
      scenario.gatewayProxy?.calls.filter((call) => call.tool === "ack_message").length,
      0,
    );
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged ?? false, false);
  }

  for (const operation of ["reply_message", "complete_message"] as const) {
    const clock = new ManualK02Clock(1_788_500_000_000);
    const scenario = await startK02Scenario(t, "K02-K03:O06", {
      clock,
      gatewayProxy: true,
      scripts: [
        [
          { kind: "session", provider_session_id: `o06_uncertain_${operation}_session` },
          { kind: "turn", provider_turn_id: `o06_uncertain_${operation}_turn` },
          ...(operation === "reply_message"
            ? ([{ kind: "reply", text: "uncertain transport reply" }] as const)
            : ([{ kind: "no_reply" }] as const)),
        ],
      ],
    });
    scenario.gatewayProxy?.failNext(operation, { kind: "drop_after_commit" });
    const message = k02Message(
      `o06_uncertain_${operation}`,
      `o06_uncertain_${operation}_conversation`,
    );
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    await waitFor(
      () => scenario.gatewayProxy?.calls.some((call) => call.tool === operation) ?? false,
      `uncertain ${operation}`,
    );
    await waitForRetrySchedule(
      scenario,
      "outcome_lookup",
      clock.nowMs() + 30_000,
      `uncertain ${operation} schedule`,
    );
    clock.advance(30_000);
    await scenario.connector.waitForIdle();
    const tools = scenario.gatewayProxy?.calls.map((call) => call.tool) ?? [];
    assert.equal(tools.filter((tool) => tool === operation).length, 1);
    assert.ok(tools.indexOf("get_message_outcome") > tools.indexOf(operation));
    assert.equal(tools.at(-1), "ack_message");
  }

  const uncertainOutcomeClock = new ManualK02Clock(1_788_550_000_000);
  const uncertainOutcome = await startK02Scenario(t, "K02-K03:O06", {
    clock: uncertainOutcomeClock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "o06_uncertain_outcome_session" },
        { kind: "turn", provider_turn_id: "o06_uncertain_outcome_turn" },
        { kind: "reply", text: "uncertain outcome lookup" },
      ],
    ],
  });
  uncertainOutcome.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
  uncertainOutcome.gatewayProxy?.failNext("get_message_outcome", { kind: "drop_after_commit" });
  const uncertainOutcomeMessage = k02Message(
    "o06_uncertain_outcome",
    "o06_uncertain_outcome_conversation",
  );
  uncertainOutcome.enqueue(uncertainOutcomeMessage);
  assert.equal(
    (
      await uncertainOutcome.wake(
        uncertainOutcomeMessage.id,
        Math.floor(uncertainOutcomeClock.nowMs() / 1_000),
      )
    ).status,
    202,
  );
  await waitFor(
    () =>
      uncertainOutcome.gatewayProxy?.calls.some((call) => call.tool === "reply_message") ?? false,
    "uncertain outcome seed",
  );
  await waitForRetrySchedule(
    uncertainOutcome,
    "outcome_lookup",
    uncertainOutcomeClock.nowMs() + 30_000,
    "uncertain outcome first schedule",
  );
  uncertainOutcomeClock.advance(30_000);
  await waitFor(
    () =>
      uncertainOutcome.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome")
        .length === 1,
    "first uncertain outcome lookup",
  );
  await waitForRetrySchedule(
    uncertainOutcome,
    "outcome_lookup",
    uncertainOutcomeClock.nowMs() + 30_000,
    "uncertain outcome second schedule",
  );
  uncertainOutcomeClock.advance(29_999);
  assert.equal(
    uncertainOutcome.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome")
      .length,
    1,
  );
  uncertainOutcomeClock.advance(1);
  await uncertainOutcome.connector.waitForIdle();
  assert.equal(
    uncertainOutcome.gatewayProxy?.calls.filter((call) => call.tool === "get_message_outcome")
      .length,
    2,
  );
  assert.equal(
    uncertainOutcome.gatewayProxy?.calls.filter((call) => call.tool === "reply_message").length,
    1,
  );

  const ackClock = new ManualK02Clock(1_788_600_000_000);
  const uncertainAck = await startK02Scenario(t, "K02-K03:O06", {
    clock: ackClock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "o06_ack_session" },
        { kind: "turn", provider_turn_id: "o06_ack_turn" },
        { kind: "reply", text: "ack transport" },
      ],
    ],
  });
  uncertainAck.gatewayProxy?.failNext("ack_message", { kind: "drop_after_commit" });
  const uncertainAckMessage = k02Message("o06_ack", "o06_ack_conversation");
  uncertainAck.enqueue(uncertainAckMessage);
  assert.equal(
    (await uncertainAck.wake(uncertainAckMessage.id, Math.floor(ackClock.nowMs() / 1_000))).status,
    202,
  );
  await waitFor(
    () => uncertainAck.gatewayProxy?.calls.some((call) => call.tool === "ack_message") ?? false,
    "uncertain acknowledgement",
  );
  await waitForRetrySchedule(
    uncertainAck,
    "ack",
    ackClock.nowMs() + 2_000,
    "uncertain acknowledgement schedule",
  );
  ackClock.advance(1_999);
  assert.equal(
    uncertainAck.gatewayProxy?.calls.filter((call) => call.tool === "ack_message").length,
    1,
  );
  ackClock.advance(1);
  await uncertainAck.connector.waitForIdle();
  assert.equal(
    uncertainAck.gatewayProxy?.calls.filter((call) => call.tool === "ack_message").length,
    2,
  );
  assert.equal(
    uncertainAck.gatewayProxy?.calls.some((call) => call.tool === "get_message_outcome"),
    false,
  );
});
