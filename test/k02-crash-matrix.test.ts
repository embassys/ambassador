import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  type K02CrashBarrier,
  type K02Scenario,
  k02Message,
  ManualK02Clock,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

async function waitForOutcomeRetry(
  scenario: K02Scenario,
  retryNotBeforeMs: number,
  label: string,
): Promise<void> {
  await waitFor(() => {
    const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
      readonly: true,
    });
    try {
      const row = database
        .prepare<[], { retry_kind: string | null; retry_not_before_ms: number | null }>(
          "SELECT retry_kind, retry_not_before_ms FROM messages",
        )
        .get();
      return row?.retry_kind === "outcome_lookup" && row.retry_not_before_ms === retryNotBeforeMs;
    } catch {
      return false;
    } finally {
      database.close();
    }
  }, label);
}

test("K02-C01 recovers all eight content-free crash barriers without duplicate work", async (t) => {
  const barriers: K02CrashBarrier[] = [
    "binding_published",
    "turn_published",
    "provider_terminal_received",
    "reply_committed_unobserved",
    "reply_accepted",
    "completion_accepted",
    "outcome_observed",
    "ack_accepted",
  ];
  for (const [index, crashAfter] of barriers.entries()) {
    const completion = crashAfter === "completion_accepted";
    const needsLostReply =
      crashAfter === "reply_committed_unobserved" || crashAfter === "outcome_observed";
    const clock = new ManualK02Clock(1_788_000_000_000 + index * 1_000_000);
    const scenario = await startK02Scenario(t, "K02-K03:C01-matrix", {
      crashAfter,
      clock,
      gatewayProxy: needsLostReply,
      scripts: [
        [
          { kind: "session", provider_session_id: `session_crash_${index}` },
          { kind: "turn", provider_turn_id: `turn_crash_${index}` },
          ...(completion
            ? ([{ kind: "no_reply" }] as const)
            : ([{ kind: "reply", text: `reply_crash_${index}` }] as const)),
        ],
      ],
    });
    if (needsLostReply) {
      scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_after_commit" });
    }
    const message = k02Message(`c01_message_${index}`, `c01_conversation_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
    if (crashAfter === "outcome_observed") {
      await waitFor(
        () => scenario.gatewayProxy?.calls.some((call) => call.tool === "reply_message") ?? false,
        "lost committed reply",
      );
      await waitForOutcomeRetry(scenario, clock.nowMs() + 30_000, "lost committed reply schedule");
      clock.advance(30_000);
    }
    await assert.rejects(scenario.connector.waitForIdle(), /connector_test_crash/u);
    await scenario.connector.crash();
    const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
      readonly: true,
    });
    try {
      const row = database
        .prepare<
          [],
          {
            lifecycle: string;
            provider_turn_hmac: Buffer | null;
            retry_attempt_count: number;
            terminal_operation: string | null;
          }
        >(
          "SELECT lifecycle, provider_turn_hmac, retry_attempt_count, terminal_operation FROM messages",
        )
        .get();
      assert.ok(row !== undefined);
      if (crashAfter === "binding_published") {
        assert.deepEqual(row, {
          lifecycle: "binding",
          provider_turn_hmac: null,
          retry_attempt_count: 0,
          terminal_operation: null,
        });
      } else if (crashAfter === "turn_published" || crashAfter === "provider_terminal_received") {
        assert.equal(row.lifecycle, "turn_running");
        assert.equal(row.provider_turn_hmac?.byteLength, 32);
        assert.equal(row.retry_attempt_count, 0);
        assert.equal(row.terminal_operation, null);
      } else {
        assert.equal(
          row.lifecycle,
          crashAfter === "ack_accepted" ? "ack_pending" : "central_pending",
        );
        assert.equal(row.provider_turn_hmac?.byteLength, 32);
        assert.equal(row.terminal_operation, completion ? "complete" : "reply");
        assert.equal(
          row.retry_attempt_count,
          crashAfter === "outcome_observed" || crashAfter === "ack_accepted" ? 2 : 1,
        );
      }
    } finally {
      database.close();
    }
    const requiresExactTurnRecovery =
      crashAfter === "turn_published" || crashAfter === "provider_terminal_received";
    const restarted = await scenario.restart(
      requiresExactTurnRecovery
        ? [
            [
              { kind: "progress", text: "exact recovery" },
              { kind: "reply", text: `reply_crash_${index}` },
            ],
          ]
        : [],
    );
    await restarted.connector.waitForIdle();
    assert.equal(
      scenario.provider.requests.filter((request) => request.kind === "start").length,
      crashAfter === "binding_published" ? 0 : 1,
    );
    if (crashAfter === "binding_published") {
      assert.equal(restarted.provider.requests.length, 0);
      assert.equal(scenario.gateway.tombstone(message.id)?.outcome, "uncertain");
    } else if (requiresExactTurnRecovery) {
      assert.equal(restarted.provider.requests.length, 1);
      const recovery = restarted.provider.requests[0];
      assert.equal(recovery?.kind, "recover");
      if (recovery?.kind === "recover") {
        assert.equal(recovery.provider_session_id, `session_crash_${index}`);
        assert.equal(recovery.provider_turn_id, `turn_crash_${index}`);
        assert.ok(!("input_text" in recovery));
      }
    } else {
      assert.equal(restarted.provider.requests.length, 0);
    }
    const calls = scenario.gateway.calls.map((call) => call.name);
    const uncertainBinding = crashAfter === "binding_published";
    assert.equal(
      calls.filter((name) => name === "reply_message").length,
      completion || uncertainBinding ? 0 : 1,
    );
    assert.equal(
      calls.filter((name) => name === "complete_message").length,
      completion || uncertainBinding ? 1 : 0,
    );
    assert.equal(
      calls.filter((name) => name === "ack_message").length,
      crashAfter === "ack_accepted" ? 2 : 1,
    );
    if (
      crashAfter === "reply_committed_unobserved" ||
      crashAfter === "reply_accepted" ||
      crashAfter === "completion_accepted"
    ) {
      assert.equal(calls.filter((name) => name === "get_message_outcome").length, 1);
    }
    if (crashAfter === "outcome_observed") {
      assert.equal(calls.filter((name) => name === "get_message_outcome").length, 2);
    }
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  }
});

test("K02-C03 dispatches once only from received and never from binding or turn_starting", async (t) => {
  const received = await startK02Scenario(t, "K02-K03:C03", {
    crashAfterReceived: true,
    scripts: [],
  });
  const receivedMessage = k02Message("c03_received", "c03_received_conversation");
  received.enqueue(receivedMessage);
  assert.equal((await received.wake(receivedMessage.id)).status, 202);
  await assert.rejects(received.connector.waitForIdle(), /connector_test_crash/u);
  assert.equal(received.provider.requests.length, 0);
  await received.connector.crash();
  const receivedRestart = await received.restart([
    [
      { kind: "session", provider_session_id: "session_c03_received" },
      { kind: "turn", provider_turn_id: "turn_c03_received" },
      { kind: "reply", text: "received recovery reply" },
    ],
  ]);
  await receivedRestart.connector.waitForIdle();
  assert.equal(receivedRestart.provider.requests.length, 1);
  assert.equal(receivedRestart.provider.requests[0]?.kind, "start");
  assert.equal(received.gateway.tombstone(receivedMessage.id)?.outcome, "replied");

  const binding = await startK02Scenario(t, "K02-K03:C03", {
    crashAfter: "binding_published",
    scripts: [[{ kind: "session", provider_session_id: "must_not_be_read" }]],
  });
  const bindingMessage = k02Message("c03_binding", "c03_binding_conversation");
  binding.enqueue(bindingMessage);
  assert.equal((await binding.wake(bindingMessage.id)).status, 202);
  await assert.rejects(binding.connector.waitForIdle(), /connector_test_crash/u);
  assert.equal(binding.provider.requests.length, 0);
  await binding.connector.crash();
  const bindingRestart = await binding.restart([], { proveNoProviderDispatch: true });
  await bindingRestart.connector.waitForIdle();
  assert.equal(bindingRestart.provider.requests.length, 0);
  assert.deepEqual(binding.gateway.tombstone(bindingMessage.id), {
    message_id: bindingMessage.id,
    conversation_id: bindingMessage.conversation_id,
    outcome: "failed",
    reply_message_id: null,
    acknowledged: true,
  });
  assert.deepEqual(binding.gateway.calls[1]?.arguments, {
    message_id: bindingMessage.id,
    outcome: "failed",
    reason_code: "provider_start_failed",
  });

  const turnStarting = await startK02Scenario(t, "K02-K03:C03", {
    crashAfterTurnStarting: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_c03_turn_starting" },
        { kind: "reply", text: "first turn" },
      ],
      [{ kind: "turn", provider_turn_id: "must_not_be_read" }],
    ],
  });
  const first = k02Message("c03_first", "c03_turn_starting_conversation");
  turnStarting.enqueue(first);
  assert.equal((await turnStarting.wake(first.id)).status, 202);
  await turnStarting.connector.waitForIdle();
  const second = k02Message(
    "c03_turn_starting",
    "c03_turn_starting_conversation",
    "second turn",
    first.id,
  );
  turnStarting.enqueue(second);
  assert.equal((await turnStarting.wake(second.id)).status, 202);
  await assert.rejects(turnStarting.connector.waitForIdle(), /connector_test_crash/u);
  assert.equal(turnStarting.provider.requests.length, 1);
  await turnStarting.connector.crash();
  const turnRestart = await turnStarting.restart([], { proveNoProviderDispatch: true });
  await turnRestart.connector.waitForIdle();
  assert.equal(turnRestart.provider.requests.length, 0);
  assert.deepEqual(turnStarting.gateway.tombstone(second.id), {
    message_id: second.id,
    conversation_id: second.conversation_id,
    outcome: "failed",
    reply_message_id: null,
    acknowledged: true,
  });
  assert.deepEqual(turnStarting.gateway.calls.at(-2)?.arguments, {
    message_id: second.id,
    outcome: "failed",
    reason_code: "provider_start_failed",
  });
});

test("K02-C04 never restores a reply plan after the durable lost-open uncertain transition", async (t) => {
  const clock = new ManualK02Clock(1_788_300_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:C04", {
    crashAfterLostReplyUncertain: true,
    clock,
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_c04" },
        { kind: "turn", provider_turn_id: "turn_c04" },
        { kind: "reply", text: "lost c04 reply" },
      ],
      [{ kind: "uncertain" }],
    ],
  });
  scenario.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
  const message = k02Message("c04_message", "c04_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id, Math.floor(clock.nowMs() / 1_000))).status, 202);
  await waitFor(
    () => scenario.gatewayProxy?.calls.some((call) => call.tool === "reply_message") ?? false,
    "lost open reply dispatch",
  );
  await waitForOutcomeRetry(scenario, clock.nowMs() + 30_000, "lost open reply schedule");
  clock.advance(30_000);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_test_crash/u);
  await scenario.connector.crash();
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      database
        .prepare<
          [],
          {
            lifecycle: string;
            retry_attempt_count: number;
            retry_kind: string | null;
            terminal_operation: string | null;
          }
        >("SELECT lifecycle, retry_attempt_count, retry_kind, terminal_operation FROM messages")
        .get(),
      {
        lifecycle: "uncertain",
        retry_attempt_count: 2,
        retry_kind: null,
        terminal_operation: null,
      },
    );
  } finally {
    database.close();
  }
  const restarted = await scenario.restart([]);
  await restarted.connector.waitForIdle();
  assert.equal(scenario.gateway.calls.filter((call) => call.name === "reply_message").length, 0);
  assert.deepEqual(scenario.gateway.calls.at(-2)?.arguments, {
    message_id: message.id,
    outcome: "uncertain",
    reason_code: "provider_outcome_unknown",
  });
  assert.equal(restarted.provider.requests.length, 0);
});
