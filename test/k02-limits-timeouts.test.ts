import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  k02Message,
  loadK02Production,
  ManualK02Clock,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

async function settleK02Tasks(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test("K02-B00 exports the accepted non-configurable connector limits", async () => {
  const module = await loadK02Production("K02-K03:B00");
  assert.deepEqual(module.CONNECTOR_LIMITS, {
    activeTurnsPerConversation: 1,
    activeTurnsGlobal: 2,
    waitingWakeIds: 100,
    acceptedWebhookSockets: 32,
    parsedWebhookRequests: 16,
    webhookRequestLineBytes: 2_048,
    webhookHeaderBytes: 16_384,
    webhookBodyBytes: 1_048_576,
    webhookHeaderDeadlineMs: 2_000,
    webhookRequestDeadlineMs: 5_000,
    gatewayMcpDeadlineMs: 35_000,
    providerDeadlineMs: 900_000,
    cancellationGraceMs: 10_000,
    containmentCleanupMs: 3_000,
    normalizedEvents: 10_000,
    providerOutputBytes: 8_388_608,
    providerIdBytes: 1_024,
    finalReplyBytes: 262_144,
  });
});

test("K02-P06 keeps one absolute deadline and cancels a proven safe wait", async (t) => {
  const clock = new ManualK02Clock(1_788_000_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:P06", {
    clock,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_deadline" },
        { kind: "turn", provider_turn_id: "turn_deadline" },
        { kind: "approval_required", approval_request_id: "approval_deadline" },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const message = k02Message("message_deadline", "conversation_deadline");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await waitFor(() => scenario.provider.pulls.length === 4, "safe provider wait");
  const request = scenario.provider.requests[0];
  assert.equal(request?.deadline_unix_ms, 1_788_000_900_000);

  clock.advance(900_000);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.provider.cancellations.length, 1);
  assert.deepEqual(scenario.provider.cancellations[0], {
    kind: "cancel",
    execution_id: request?.execution_id,
    provider_session_id: "session_deadline",
    provider_turn_id: "turn_deadline",
    reason: "deadline",
  });
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages", "complete_message", "ack_message"],
  );
  assert.deepEqual(scenario.gateway.calls[1]?.arguments, {
    message_id: message.id,
    outcome: "cancelled",
    reason_code: "cancelled_during_safe_wait",
  });

  const rollbackClock = new ManualK02Clock(1_788_100_000_000);
  const rollback = await startK02Scenario(t, "K02-K03:P06", {
    clock: rollbackClock,
    crashAfter: "turn_published",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_rollback" },
        { kind: "turn", provider_turn_id: "turn_rollback" },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const rollbackMessage = k02Message("message_rollback", "conversation_rollback");
  rollback.enqueue(rollbackMessage);
  assert.equal((await rollback.wake(rollbackMessage.id)).status, 202);
  await assert.rejects(rollback.connector.waitForIdle(), /connector_test_crash/u);
  await rollback.connector.crash();
  rollbackClock.set(1_788_099_999_999);
  await assert.rejects(rollback.restart([]), /connector_state_unavailable/u);

  const graceStart = 1_788_200_000_000;
  const graceClock = new ManualK02Clock(graceStart);
  const grace = await startK02Scenario(t, "K02-K03:P06", {
    clock: graceClock,
    crashAfterCancellation: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_restart_grace" },
        { kind: "turn", provider_turn_id: "turn_restart_grace" },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const graceMessage = k02Message("message_restart_grace", "conversation_restart_grace");
  grace.enqueue(graceMessage);
  assert.equal((await grace.wake(graceMessage.id)).status, 202);
  await waitFor(() => grace.provider.pulls.length === 3, "restart grace provider wait");
  graceClock.advance(900_000);
  await assert.rejects(grace.connector.waitForIdle(), /connector_test_crash/u);
  await grace.connector.crash();
  graceClock.set(graceStart + 909_999);
  const restarted = await grace.restart([]);
  assert.equal(restarted.providerPort.containmentAttempts, 0);
  graceClock.advance(1);
  await restarted.connector.waitForIdle();
  assert.equal(restarted.providerPort.containmentAttempts, 1);
  graceClock.advance(1);
  assert.equal(restarted.providerPort.containmentAttempts, 1);
  assert.equal(restarted.provider.requests.length, 0);

  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };

  await check("delayed dispatch", async () => {
    const startedAt = 1_788_300_000_000;
    const delayedClock = new ManualK02Clock(startedAt);
    const delayed = await startK02Scenario(t, "K02-K03:P06", {
      clock: delayedClock,
      providerDispatchDelayMsForTest: 120_000,
      scripts: [
        [
          { kind: "session", provider_session_id: "session_delayed_dispatch" },
          { kind: "turn", provider_turn_id: "turn_delayed_dispatch" },
          { kind: "wait_for_cancel" },
        ],
      ],
    });
    try {
      const delayedMessage = k02Message(
        "message_delayed_dispatch",
        "conversation_delayed_dispatch",
      );
      delayed.enqueue(delayedMessage);
      assert.equal((await delayed.wake(delayedMessage.id)).status, 202);
      await waitFor(() => {
        const database = new Database(`${delayed.stateDirectory}/correlation.sqlite3`, {
          readonly: true,
        });
        try {
          const row = database
            .prepare<[], { turn_deadline_ms: number | null }>(
              "SELECT turn_deadline_ms FROM messages",
            )
            .get();
          return row !== undefined && row.turn_deadline_ms !== null;
        } finally {
          database.close();
        }
      }, "durable delayed dispatch decision");
      await settleK02Tasks();
      assert.equal(
        delayed.provider.requests.length,
        0,
        "provider dispatch occurred before the content-free delayed-dispatch barrier",
      );
      delayedClock.advance(120_000);
      await waitFor(() => delayed.provider.requests.length === 1, "delayed provider dispatch");
      assert.equal(delayed.provider.requests[0]?.deadline_unix_ms, startedAt + 900_000);
      delayedClock.advance(779_999);
      assert.equal(delayed.provider.cancellations.length, 0);
      delayedClock.advance(1);
      await waitFor(() => delayed.provider.cancellations.length === 1, "remaining deadline");
    } finally {
      await delayed.connector.crash();
    }
  });

  await check("hanging recovery", async () => {
    const startedAt = 1_788_400_000_000;
    const recoveryClock = new ManualK02Clock(startedAt);
    const original = await startK02Scenario(t, "K02-K03:P06", {
      clock: recoveryClock,
      crashAfter: "turn_published",
      scripts: [
        [
          { kind: "session", provider_session_id: "session_hanging_recovery" },
          { kind: "turn", provider_turn_id: "turn_hanging_recovery" },
          { kind: "wait_for_cancel" },
        ],
      ],
    });
    const recoveryMessage = k02Message("message_hanging_recovery", "conversation_hanging_recovery");
    original.enqueue(recoveryMessage);
    assert.equal((await original.wake(recoveryMessage.id)).status, 202);
    await assert.rejects(original.connector.waitForIdle(), /connector_test_crash/u);
    await original.connector.crash();
    recoveryClock.advance(600_000);
    const recovered = await original.restart([[{ kind: "wait_for_cancel" }]]);
    try {
      await waitFor(() => recovered.provider.requests.length === 1, "hanging recovery attach");
      const request = recovered.provider.requests[0];
      assert.equal(request?.kind, "recover");
      assert.equal(request?.deadline_unix_ms, startedAt + 900_000);
      assert.ok(
        recoveryClock.pendingTimerCountForTest() >= 1,
        "recovery did not arm the original deadline's remaining interval",
      );
      recoveryClock.advance(299_999);
      assert.equal(recovered.provider.cancellations.length, 0);
      recoveryClock.advance(1);
      await waitFor(
        () => recovered.provider.cancellations.length === 1,
        "hanging recovery deadline cancellation",
      );
    } finally {
      await recovered.connector.crash();
    }
  });

  await check("approval grace and containment", async () => {
    const approvalClock = new ManualK02Clock(1_788_500_000_000);
    const approval = await startK02Scenario(t, "K02-K03:P06", {
      clock: approvalClock,
      contained: true,
      gateContainment: true,
      gatedEvents: ["cancelled"],
      scripts: [
        [
          { kind: "session", provider_session_id: "session_approval_grace" },
          { kind: "turn", provider_turn_id: "turn_approval_grace" },
          { kind: "approval_required", approval_request_id: "approval_grace" },
          { kind: "wait_for_cancel" },
        ],
      ],
    });
    try {
      const approvalMessage = k02Message("message_approval_grace", "conversation_approval_grace");
      approval.enqueue(approvalMessage);
      assert.equal((await approval.wake(approvalMessage.id)).status, 202);
      await waitFor(() => approval.provider.pulls.length === 4, "approval deadline wait");
      approvalClock.advance(900_000);
      await waitFor(() => approval.provider.cancellations.length === 1, "approval cancellation");
      assert.ok(
        approvalClock.pendingTimerCountForTest() >= 1,
        "approval wait did not continue through the one absolute grace",
      );
      approvalClock.advance(9_999);
      assert.equal(approval.providerPort.containmentAttempts, 0);
      approvalClock.advance(1);
      await settleK02Tasks();
      assert.equal(
        approval.providerPort.containmentAttempts,
        1,
        "approval wait skipped qualified containment after grace",
      );
      approval.releaseContainment();
      approval.releaseProviderEvent("cancelled");
    } finally {
      await approval.connector.crash();
    }
  });

  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
});

test("K02-B01 accepts 10000 normalized events and rejects event 10001", async (t) => {
  const exactScript = [
    { kind: "session", provider_session_id: "session_events_exact" },
    { kind: "turn", provider_turn_id: "turn_events_exact" },
    ...Array.from({ length: 9_997 }, () => ({ kind: "progress", text: "x" }) as const),
    { kind: "reply", text: "exact event boundary" },
  ] as const;
  const excessScript = [
    { kind: "session", provider_session_id: "session_events_excess" },
    { kind: "turn", provider_turn_id: "turn_events_excess" },
    ...Array.from({ length: 9_998 }, () => ({ kind: "progress", text: "x" }) as const),
    { kind: "reply", text: "unaccepted excess event" },
  ] as const;
  const scenario = await startK02Scenario(t, "K02-K03:B01", {
    scripts: [exactScript, excessScript],
  });

  const exact = k02Message("message_events_exact", "conversation_events_exact");
  scenario.enqueue(exact);
  assert.equal((await scenario.wake(exact.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.tombstone(exact.id)?.outcome, "replied");

  const excess = k02Message("message_events_excess", "conversation_events_excess");
  scenario.enqueue(excess);
  assert.equal((await scenario.wake(excess.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.provider.cancellations.at(-1)?.reason, "output_limit");
  assert.deepEqual(scenario.gateway.calls.at(-2), {
    name: "complete_message",
    arguments: {
      message_id: excess.id,
      outcome: "uncertain",
      reason_code: "provider_outcome_unknown",
    },
  });
  assert.equal(scenario.gateway.tombstone(excess.id)?.outcome, "uncertain");
});

test("K02-B05 accepts an exact reply and rejects one-over without truncation or reflection", async (t) => {
  const exactText = "é".repeat(131_072);
  assert.equal(Buffer.byteLength(exactText), 262_144);
  const scenario = await startK02Scenario(t, "K02-K03:B05", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_reply_exact" },
        { kind: "turn", provider_turn_id: "turn_reply_exact" },
        { kind: "reply", text: exactText },
      ],
      [
        { kind: "session", provider_session_id: "session_reply_limit" },
        { kind: "turn", provider_turn_id: "turn_reply_limit" },
        { kind: "oversized", event: "reply", text_bytes: 262_145 },
      ],
    ],
  });
  const exact = k02Message("message_reply_exact", "conversation_reply_exact");
  scenario.enqueue(exact);
  assert.equal((await scenario.wake(exact.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.tombstone(exact.id)?.outcome, "replied");
  const message = k02Message("message_reply_limit", "conversation_reply_limit");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.provider.cancellations[0]?.reason, "output_limit");
  assert.deepEqual(
    scenario.gateway.calls.slice(-3).map((call) => call.name),
    ["poll_messages", "complete_message", "ack_message"],
  );
  assert.ok(!JSON.stringify(scenario.gateway.calls).includes("x".repeat(1_024)));
});

test("K02-B02 accepts 1024-byte provider IDs and rejects each 1025-byte field", async (t) => {
  const exact = "é".repeat(512);
  const excess = `${exact}x`;
  assert.equal(Buffer.byteLength(exact), 1_024);
  assert.equal(Buffer.byteLength(excess), 1_025);
  const scenario = await startK02Scenario(t, "K02-K03:B02", {
    scripts: [
      [
        { kind: "session", provider_session_id: exact },
        { kind: "turn", provider_turn_id: exact },
        { kind: "approval_required", approval_request_id: exact },
        { kind: "approval_resolved", approval_request_id: exact, decision: "denied" },
        { kind: "reply", text: "exact IDs accepted" },
      ],
      [{ kind: "session", provider_session_id: excess }],
      [
        { kind: "session", provider_session_id: "session_turn_excess" },
        { kind: "turn", provider_turn_id: excess },
      ],
      [
        { kind: "session", provider_session_id: "session_approval_excess" },
        { kind: "turn", provider_turn_id: "turn_approval_excess" },
        { kind: "approval_required", approval_request_id: excess },
      ],
    ],
  });
  const accepted = k02Message("b02_exact", "b02_conversation_exact");
  scenario.enqueue(accepted);
  assert.equal((await scenario.wake(accepted.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.tombstone(accepted.id)?.outcome, "replied");
  for (const field of ["session", "turn", "approval"] as const) {
    const rejected = k02Message(`b02_${field}_excess`, `b02_${field}_conversation_excess`);
    scenario.enqueue(rejected);
    assert.equal((await scenario.wake(rejected.id)).status, 202);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.provider.cancellations.at(-1)?.reason, "contract_failure");
    assert.equal(scenario.gateway.tombstone(rejected.id)?.outcome, "uncertain");
  }
});

test("K02-B03 accepts 262144-byte progress and rejects 262145 bytes without reflection", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:B03", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_progress_exact" },
        { kind: "turn", provider_turn_id: "turn_progress_exact" },
        { kind: "oversized", event: "progress", text_bytes: 262_144 },
        { kind: "reply", text: "progress accepted" },
      ],
      [
        { kind: "session", provider_session_id: "session_progress_excess" },
        { kind: "turn", provider_turn_id: "turn_progress_excess" },
        { kind: "oversized", event: "progress", text_bytes: 262_145 },
      ],
    ],
  });
  const exact = k02Message("b03_exact", "b03_conversation_exact");
  scenario.enqueue(exact);
  assert.equal((await scenario.wake(exact.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.tombstone(exact.id)?.outcome, "replied");
  assert.deepEqual(
    scenario.gateway.calls.slice(-3).map((call) => call.name),
    ["poll_messages", "reply_message", "ack_message"],
  );
  assert.equal(scenario.provider.cancellations.length, 0);

  const excess = k02Message("b03_excess", "b03_conversation_excess");
  scenario.enqueue(excess);
  assert.equal((await scenario.wake(excess.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.provider.cancellations.length, 1);
  assert.equal(scenario.provider.cancellations[0]?.reason, "output_limit");
  assert.equal(scenario.gateway.tombstone(excess.id)?.outcome, "uncertain");
  assert.ok(!JSON.stringify(scenario.gateway.calls).includes("x".repeat(1_024)));
});

test("K02-B04 enforces independent 8 MiB stdout and stderr capture limits", async () => {
  const module = await loadK02Production("K02-K03:B04");
  async function* chunks(bytes: number): AsyncIterable<Uint8Array> {
    const block = new Uint8Array(64 * 1_024);
    let remaining = bytes;
    while (remaining > 0) {
      const size = Math.min(block.byteLength, remaining);
      yield block.subarray(0, size);
      remaining -= size;
    }
  }
  for (const stream of ["stdout", "stderr"] as const) {
    assert.equal(await module.consumeProviderOutput(stream, chunks(8_388_608)), 8_388_608);
    await assert.rejects(
      module.consumeProviderOutput(stream, chunks(8_388_609)),
      /connector_provider_output_limit/u,
    );
  }
});

test("K02-L01 cancels one local gateway MCP request at the fixed 35-second timeout", async (t) => {
  const clock = new ManualK02Clock(1_788_000_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:L01", {
    clock,
    gatewayProxy: true,
  });
  scenario.gatewayProxy?.failNext("poll_messages", { kind: "hold" });
  assert.equal((await scenario.wake("mcp_timeout_message")).status, 202);
  await waitFor(
    () => scenario.gatewayProxy?.calls.some((call) => call.tool === "poll_messages") ?? false,
    "held MCP poll",
  );
  assert.deepEqual(
    scenario.gatewayProxy?.calls
      .map((call) => call.method)
      .filter((method) => method !== undefined)
      .slice(0, 3),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  clock.advance(34_999);
  assert.equal(scenario.provider.requests.length, 0);
  clock.advance(1);
  scenario.gatewayProxy?.release("poll_messages");
  await assert.rejects(scenario.connector.waitForIdle(), /connector_gateway_operation_failed/u);
  assert.equal(scenario.provider.requests.length, 0);
});

test("K02-P07 waits one absolute grace then performs three-second qualified containment", async (t) => {
  for (const outcome of ["success_at_2999", "timeout_at_3000"] as const) {
    const clock = new ManualK02Clock(1_788_000_000_000);
    const scenario = await startK02Scenario(t, "K02-K03:P07-grace", {
      clock,
      contained: true,
      gateContainment: true,
      gatedEvents: ["cancelled"],
      scripts: [
        [
          { kind: "session", provider_session_id: `session_grace_${outcome}` },
          { kind: "turn", provider_turn_id: `turn_grace_${outcome}` },
          { kind: "progress", text: "stateful work" },
          { kind: "wait_for_cancel" },
        ],
      ],
    });
    const message = k02Message(`grace_message_${outcome}`, `grace_conversation_${outcome}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await waitFor(() => scenario.provider.pulls.length === 4, "unresponsive cancellation wait");
    clock.advance(900_000);
    await waitFor(() => scenario.provider.cancellations.length === 1, "deadline cancellation");
    clock.advance(9_999);
    assert.equal(scenario.providerPort.containmentAttempts, 0);
    clock.advance(1);
    await waitFor(() => scenario.providerPort.containmentAttempts === 1, "qualified containment");
    clock.advance(2_999);
    assert.equal(scenario.gateway.tombstone(message.id), undefined);
    if (outcome === "success_at_2999") {
      scenario.releaseContainment();
      await scenario.connector.waitForIdle();
      assert.equal(scenario.gateway.tombstone(message.id)?.outcome, "uncertain");
    } else {
      clock.advance(1);
      await assert.rejects(
        scenario.connector.waitForIdle(),
        /connector_provider_cleanup_incomplete/u,
      );
      assert.equal(scenario.gateway.tombstone(message.id), undefined);
      scenario.releaseContainment();
    }
  }
});

test("K02-SD01 bounds SIGINT and SIGTERM-style shutdown to one 15-second budget", async (t) => {
  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const waiting = (suffix: string) =>
      [
        { kind: "session", provider_session_id: `session_shutdown_${suffix}` },
        { kind: "turn", provider_turn_id: `turn_shutdown_${suffix}` },
        { kind: "wait_for_cancel" },
      ] as const;

    await check(`${signal} cleanup proof`, async () => {
      const clock = new ManualK02Clock(1_788_000_000_000);
      const scenario = await startK02Scenario(t, "K02-K03:SD01", {
        clock,
        contained: true,
        scripts: [waiting("one"), waiting("two")],
      });
      for (const index of [1, 2]) {
        const message = k02Message(
          `shutdown_${signal}_clean_${index}`,
          `shutdown_conversation_${signal}_clean_${index}`,
        );
        scenario.enqueue(message);
        assert.equal((await scenario.wake(message.id)).status, 202);
      }
      await waitFor(() => scenario.provider.activeExecutionCount === 2, "two shutdown turns");
      const shutdown = scenario.connector.shutdown(signal);
      await waitFor(
        () => scenario.provider.cancellations.length === 2,
        "parallel shutdown cancels",
      );
      clock.advance(10_000);
      await settleK02Tasks();
      assert.equal(
        scenario.providerPort.containmentAttempts,
        2,
        "clean shutdown did not prove cleanup for both active executions",
      );
      clock.advance(5_000);
      await shutdown;
      assert.ok(scenario.provider.cancellations.every((request) => request.reason === "shutdown"));
    });

    await check(`${signal} incomplete cleanup`, async () => {
      const clock = new ManualK02Clock(1_788_100_000_000);
      const scenario = await startK02Scenario(t, "K02-K03:SD01", {
        clock,
        contained: false,
        gateContainment: true,
        scripts: [waiting("incomplete")],
      });
      const message = k02Message(
        `shutdown_${signal}_incomplete`,
        `shutdown_conversation_${signal}_incomplete`,
      );
      scenario.enqueue(message);
      assert.equal((await scenario.wake(message.id)).status, 202);
      await waitFor(() => scenario.provider.activeExecutionCount === 1, "incomplete shutdown turn");
      const shutdown = scenario.connector.shutdown(signal);
      await waitFor(
        () => scenario.provider.cancellations.length === 1,
        "incomplete shutdown cancellation",
      );
      clock.advance(15_000);
      await settleK02Tasks();
      try {
        await assert.rejects(shutdown, /connector_shutdown_incomplete/u);
      } finally {
        scenario.releaseContainment();
      }
      assert.equal(scenario.providerPort.containmentAttempts, 1);
    });
  }

  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
});
