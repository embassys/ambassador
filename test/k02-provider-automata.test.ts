import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  type K02ProviderStep,
  type K02Scenario,
  type K02StateFaultBarrier,
  k02Message,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

function assertDurableProviderState(
  scenario: K02Scenario,
  expected: { message: string; conversation: string; session: boolean; turn: boolean },
): void {
  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    const row = database
      .prepare<
        [],
        {
          conversation_lifecycle: string;
          message_lifecycle: string;
          provider_session_hmac: Buffer | null;
          provider_turn_hmac: Buffer | null;
        }
      >(
        "SELECT c.lifecycle AS conversation_lifecycle, m.lifecycle AS message_lifecycle, c.provider_session_hmac, m.provider_turn_hmac FROM conversations c JOIN messages m USING(conversation_hmac)",
      )
      .get();
    assert.ok(row !== undefined);
    assert.equal(row.message_lifecycle, expected.message);
    assert.equal(row.conversation_lifecycle, expected.conversation);
    assert.equal(row.provider_session_hmac !== null, expected.session);
    assert.equal(row.provider_turn_hmac !== null, expected.turn);
  } finally {
    database.close();
  }
}

test("K02-P01 enforces every start first-event and binding transition edge", async (t) => {
  const vectors = [
    {
      script: [{ kind: "unsupported", reason_code: "unsupported_message_type" }],
      outcome: "unsupported",
      reason: "unsupported_message_type",
    },
    {
      script: [{ kind: "unsupported", reason_code: "unsupported_payload" }],
      outcome: "unsupported",
      reason: "unsupported_payload",
    },
    {
      script: [{ kind: "failed", reason_code: "provider_start_failed" }],
      outcome: "failed",
      reason: "provider_start_failed",
    },
    {
      script: [{ kind: "cancelled", reason_code: "cancelled_before_execution" }],
      outcome: "cancelled",
      reason: "cancelled_before_execution",
    },
    {
      script: [{ kind: "uncertain" }],
      outcome: "uncertain",
      reason: "provider_outcome_unknown",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_start_progress" },
        { kind: "progress", text: "progress" },
        { kind: "reply", text: "no-turn reply" },
      ],
      outcome: "replied",
      reason: null,
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_direct_reply" },
        { kind: "reply", text: "direct no-turn reply" },
      ],
      outcome: "replied",
      reason: null,
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_start_turn" },
        { kind: "turn", provider_turn_id: "turn_start" },
        { kind: "reply", text: "bound reply" },
      ],
      outcome: "replied",
      reason: null,
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_first_approval" },
        { kind: "approval_required", approval_request_id: "approval_first" },
        { kind: "approval_resolved", approval_request_id: "approval_first", decision: "denied" },
        { kind: "no_reply" },
      ],
      outcome: "completed_without_reply",
      reason: "no_reply_required",
    },
    {
      script: [{ kind: "session", provider_session_id: "session_no_reply" }, { kind: "no_reply" }],
      outcome: "completed_without_reply",
      reason: "no_reply_required",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_execution_failed" },
        { kind: "failed", reason_code: "provider_execution_failed" },
      ],
      outcome: "failed",
      reason: "provider_execution_failed",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_result_invalid" },
        { kind: "failed", reason_code: "provider_result_invalid" },
      ],
      outcome: "failed",
      reason: "provider_result_invalid",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_safe_unsupported_type" },
        { kind: "unsupported", reason_code: "unsupported_message_type" },
      ],
      outcome: "unsupported",
      reason: "unsupported_message_type",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_safe_unsupported_payload" },
        { kind: "unsupported", reason_code: "unsupported_payload" },
      ],
      outcome: "unsupported",
      reason: "unsupported_payload",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_safe_start_failed" },
        { kind: "failed", reason_code: "provider_start_failed" },
      ],
      outcome: "failed",
      reason: "provider_start_failed",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_cancelled" },
        { kind: "cancelled_safe_wait" },
      ],
      outcome: "cancelled",
      reason: "cancelled_during_safe_wait",
    },
    {
      script: [
        { kind: "session", provider_session_id: "session_safe_uncertain" },
        { kind: "uncertain" },
      ],
      outcome: "uncertain",
      reason: "provider_outcome_unknown",
    },
  ] satisfies {
    script: readonly K02ProviderStep[];
    outcome: string;
    reason: string | null;
  }[];
  for (const [index, vector] of vectors.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:P01", {
      gatewayProxy: true,
      scripts: [vector.script],
    });
    const message = k02Message(`p01_message_${index}`, `p01_conversation_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.provider.requests.length, 1);
    assert.equal(scenario.provider.requests[0]?.kind, "start");
    const terminal = scenario.gateway.calls[1];
    if (vector.outcome === "replied") {
      const reply = vector.script.find((step) => step.kind === "reply");
      assert.ok(reply?.kind === "reply");
      assert.deepEqual(
        scenario.gatewayProxy?.calls.find((call) => call.tool === "reply_message")?.arguments,
        { message_id: message.id, payload: { text: reply.text } },
      );
      assert.deepEqual(terminal, {
        name: "reply_message",
        arguments: {
          message_id: message.id,
          payload_text_bytes: Buffer.byteLength(reply.text),
        },
      });
    } else {
      assert.deepEqual(terminal, {
        name: "complete_message",
        arguments: {
          message_id: message.id,
          outcome: vector.outcome,
          reason_code: vector.reason,
        },
      });
    }
    assert.equal(scenario.gateway.calls[2]?.name, "ack_message");
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  }

  const binding = { message: "binding", conversation: "binding", session: false, turn: false };
  const turnStarting = {
    message: "turn_starting",
    conversation: "active",
    session: true,
    turn: false,
  };
  const runningUnbound = {
    message: "turn_running",
    conversation: "active",
    session: true,
    turn: false,
  };
  const runningBound = { ...runningUnbound, turn: true };
  const publicationCases: {
    script: readonly K02ProviderStep[];
    gates: readonly {
      event: string;
      pulls: number;
      state: Parameters<typeof assertDurableProviderState>[1];
    }[];
  }[] = [
    {
      script: [{ kind: "unsupported", reason_code: "unsupported_payload" }],
      gates: [{ event: "unsupported", pulls: 1, state: binding }],
    },
    {
      script: [
        { kind: "session", provider_session_id: "p01_gate_unbound_session" },
        { kind: "progress", text: "first no-turn progress" },
        { kind: "reply", text: "gated no-turn reply" },
      ],
      gates: [
        { event: "session_bound", pulls: 1, state: binding },
        { event: "progress", pulls: 2, state: turnStarting },
        { event: "reply", pulls: 3, state: runningUnbound },
      ],
    },
    {
      script: [
        { kind: "session", provider_session_id: "p01_gate_bound_session" },
        { kind: "turn", provider_turn_id: "p01_gate_bound_turn" },
        { kind: "no_reply" },
      ],
      gates: [
        { event: "session_bound", pulls: 1, state: binding },
        { event: "turn_bound", pulls: 2, state: turnStarting },
        { event: "completed_without_reply", pulls: 3, state: runningBound },
      ],
    },
    {
      script: [
        { kind: "session", provider_session_id: "p01_gate_approval_session" },
        { kind: "approval_required", approval_request_id: "p01_gate_approval" },
        {
          kind: "approval_resolved",
          approval_request_id: "p01_gate_approval",
          decision: "denied",
        },
        { kind: "no_reply" },
      ],
      gates: [
        { event: "session_bound", pulls: 1, state: binding },
        { event: "approval_required", pulls: 2, state: turnStarting },
        {
          event: "approval_resolved",
          pulls: 3,
          state: { ...runningUnbound, message: "waiting_for_approval" },
        },
        { event: "completed_without_reply", pulls: 4, state: runningUnbound },
      ],
    },
  ];
  for (const [index, publication] of publicationCases.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:P01", {
      scripts: [publication.script],
      gatedEvents: publication.gates.map((gate) => gate.event),
    });
    const message = k02Message(`p01_gate_${index}`, `p01_gate_conversation_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    for (const gate of publication.gates) {
      await waitFor(() => scenario.provider.pulls.length === gate.pulls, `${gate.event} pull gate`);
      assertDurableProviderState(scenario, gate.state);
      scenario.releaseProviderEvent(gate.event);
    }
    await scenario.connector.waitForIdle();
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  }
});

test("K02-P02 resumes only the stored session and rejects a second session binding", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:P02", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_resume" },
        { kind: "turn", provider_turn_id: "turn_first" },
        { kind: "reply", text: "first" },
      ],
      [
        { kind: "turn", provider_turn_id: "turn_second" },
        { kind: "reply", text: "second" },
      ],
      [
        { kind: "session", provider_session_id: "session_illegal_rebind" },
        { kind: "reply", text: "must not publish" },
      ],
    ],
  });
  const first = k02Message("p02_first", "p02_conversation");
  scenario.enqueue(first);
  assert.equal((await scenario.wake(first.id)).status, 202);
  await scenario.connector.waitForIdle();
  const second = k02Message("p02_second", "p02_conversation", "second turn", first.id);
  scenario.enqueue(second);
  assert.equal((await scenario.wake(second.id)).status, 202);
  await scenario.connector.waitForIdle();
  const resume = scenario.provider.requests[1];
  assert.equal(resume?.kind, "resume");
  if (resume?.kind === "resume") assert.equal(resume.provider_session_id, "session_resume");
  const third = k02Message("p02_third", "p02_conversation", "third turn", second.id);
  scenario.enqueue(third);
  assert.equal((await scenario.wake(third.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.provider.requests[2]?.kind, "resume");
  assert.equal(scenario.provider.cancellations.at(-1)?.reason, "contract_failure");
  assert.equal(scenario.gateway.tombstone(third.id)?.outcome, "uncertain");
});

test("K02-P03 binds exact recovery before output and makes no-turn crashes uncertain", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:P03", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_recover" },
        { kind: "turn", provider_turn_id: "turn_recover" },
        { kind: "close" },
      ],
      [
        { kind: "progress", text: "recovered" },
        { kind: "reply", text: "exact reply" },
      ],
    ],
  });
  const message = k02Message("p03_exact", "p03_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();
  assert.deepEqual(
    scenario.provider.requests.map((request) => request.kind),
    ["start", "recover"],
  );
  const recovery = scenario.provider.requests[1];
  if (recovery?.kind === "recover") {
    assert.equal(recovery.provider_turn_id, "turn_recover");
    assert.ok(!("input_text" in recovery));
  }

  const sessionOnly = await startK02Scenario(t, "K02-K03:P03", {
    crashForRecoveryState: "session_binding",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_only_recover" },
        { kind: "turn", provider_turn_id: "must_not_be_read_before_crash" },
      ],
    ],
  });
  const sessionOnlyMessage = k02Message("p03_session_only", "p03_session_only_conversation");
  sessionOnly.enqueue(sessionOnlyMessage);
  assert.equal((await sessionOnly.wake(sessionOnlyMessage.id)).status, 202);
  await assert.rejects(sessionOnly.connector.waitForIdle(), /connector_test_crash/u);
  assert.equal(sessionOnly.provider.pulls.length, 1);
  await sessionOnly.connector.crash();
  const sessionOnlyRestart = await sessionOnly.restart([
    [
      { kind: "turn", provider_turn_id: "turn_bound_on_recovery" },
      { kind: "progress", text: "qualified session-only recovery" },
      { kind: "reply", text: "session-only reply" },
    ],
  ]);
  await sessionOnlyRestart.connector.waitForIdle();
  assert.equal(sessionOnlyRestart.provider.requests.length, 1);
  const sessionOnlyRecovery = sessionOnlyRestart.provider.requests[0];
  assert.equal(sessionOnlyRecovery?.kind, "recover");
  if (sessionOnlyRecovery?.kind === "recover") {
    assert.equal(sessionOnlyRecovery.provider_session_id, "session_only_recover");
    assert.equal(sessionOnlyRecovery.provider_turn_id, null);
    assert.ok(!("input_text" in sessionOnlyRecovery));
  }
  assert.equal(
    [...sessionOnly.provider.requests, ...sessionOnlyRestart.provider.requests].filter(
      (request) => request.kind === "start",
    ).length,
    1,
  );
  assert.equal(sessionOnly.gateway.tombstone(sessionOnlyMessage.id)?.outcome, "replied");

  for (const state of ["turn_running", "waiting_for_approval"] as const) {
    const noTurnScenario = await startK02Scenario(t, "K02-K03:P03", {
      crashAtUnboundState: state,
      scripts: [
        [
          { kind: "session", provider_session_id: `session_without_turn_${state}` },
          ...(state === "turn_running"
            ? ([{ kind: "progress", text: "provider may have acted" }] as const)
            : ([
                { kind: "approval_required", approval_request_id: "approval_without_turn" },
              ] as const)),
          { kind: "close" },
        ],
      ],
    });
    const noTurn = k02Message(`p03_no_turn_${state}`, `p03_no_turn_conversation_${state}`);
    noTurnScenario.enqueue(noTurn);
    assert.equal((await noTurnScenario.wake(noTurn.id)).status, 202);
    await assert.rejects(noTurnScenario.connector.waitForIdle(), /connector_test_crash/u);
    await noTurnScenario.connector.crash();
    const restarted = await noTurnScenario.restart([]);
    await restarted.connector.waitForIdle();
    assert.deepEqual(
      noTurnScenario.provider.requests.map((request) => request.kind),
      ["start"],
    );
    assert.equal(restarted.provider.requests.length, 0);
    assert.equal(noTurnScenario.gateway.tombstone(noTurn.id)?.outcome, "uncertain");
  }
});

test("K02-P08 foundation crash seam makes no injected-port or central recovery call", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:P08", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_owner_death" },
        { kind: "turn", provider_turn_id: "turn_owner_death" },
        { kind: "wait_for_cancel" },
      ],
    ],
  });
  const message = k02Message("p08_message", "p08_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await waitFor(() => scenario.provider.activeExecutionCount === 1, "owned provider process");
  await scenario.connector.crash();
  assert.equal(scenario.provider.requests.length, 1);
  assert.equal(scenario.provider.cancellations.length, 0);
  assert.equal(scenario.providerPort.containmentAttempts, 0);
  assert.deepEqual(
    scenario.gateway.calls.map((call) => call.name),
    ["poll_messages"],
  );
  assert.equal(scenario.gateway.tombstone(message.id), undefined);
});

test("K02-P09 stops pulling when durable publication fails at each binding barrier", async (t) => {
  const cases: {
    failStateAfter: K02StateFaultBarrier;
    script: readonly K02ProviderStep[];
    pulls: number;
  }[] = [
    {
      failStateAfter: "session_bound",
      script: [
        { kind: "session", provider_session_id: "p09_failed_session" },
        { kind: "progress", text: "must not be pulled" },
      ],
      pulls: 1,
    },
    {
      failStateAfter: "turn_bound",
      script: [
        { kind: "session", provider_session_id: "p09_turn_session" },
        { kind: "turn", provider_turn_id: "p09_failed_turn" },
        { kind: "progress", text: "must not be pulled" },
      ],
      pulls: 2,
    },
    {
      failStateAfter: "first_progress",
      script: [
        { kind: "session", provider_session_id: "p09_unbound_progress_session" },
        { kind: "progress", text: "failed no-turn progress publication" },
        { kind: "reply", text: "must not be pulled" },
      ],
      pulls: 2,
    },
    {
      failStateAfter: "approval_required",
      script: [
        { kind: "session", provider_session_id: "p09_unbound_approval_session" },
        { kind: "approval_required", approval_request_id: "p09_failed_approval" },
        {
          kind: "approval_resolved",
          approval_request_id: "p09_failed_approval",
          decision: "approved",
        },
      ],
      pulls: 2,
    },
    {
      failStateAfter: "terminal_plan",
      script: [
        { kind: "session", provider_session_id: "p09_unbound_terminal_session" },
        { kind: "reply", text: "failed no-turn terminal publication" },
      ],
      pulls: 2,
    },
  ];
  for (const [index, vector] of cases.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:P09", {
      failStateAfter: vector.failStateAfter,
      scripts: [vector.script],
    });
    const message = k02Message(`p09_message_${index}`, `p09_conversation_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await assert.rejects(scenario.connector.waitForIdle(), /connector_state_unavailable/u);
    assert.equal(scenario.provider.pulls.length, vector.pulls);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(scenario.provider.pulls.length, vector.pulls);
    assert.equal(scenario.provider.cancellations[0]?.reason, "state_failure");
    assert.equal(
      scenario.gateway.calls.some(
        (call) => call.name === "reply_message" || call.name === "complete_message",
      ),
      false,
    );
    await scenario.connector.crash();
    const restarted = await scenario.restart([[{ kind: "uncertain" }]]);
    await restarted.connector.waitForIdle();
    assert.ok(
      restarted.provider.requests.every(
        (request) => request.kind !== "start" && request.kind !== "resume",
      ),
    );
    assert.ok(
      [...scenario.provider.requests, ...restarted.provider.requests].filter(
        (request) => request.kind === "start",
      ).length === 1,
    );
  }
});

test("K02-P10 rejects malformed, misordered, wrong-execution, and post-terminal events", async (t) => {
  const eventSchemas: readonly {
    event: string;
    fields: Readonly<Record<string, string>>;
    prefix: readonly K02ProviderStep[];
  }[] = [
    { event: "session_bound", fields: { provider_session_id: "schema_session" }, prefix: [] },
    {
      event: "turn_bound",
      fields: { provider_turn_id: "schema_turn" },
      prefix: [{ kind: "session", provider_session_id: "schema_turn_session" }],
    },
    {
      event: "progress",
      fields: { text: "schema progress" },
      prefix: [{ kind: "session", provider_session_id: "schema_progress_session" }],
    },
    {
      event: "approval_required",
      fields: { approval_request_id: "schema_approval" },
      prefix: [{ kind: "session", provider_session_id: "schema_approval_session" }],
    },
    {
      event: "approval_resolved",
      fields: { approval_request_id: "schema_approval", decision: "approved" },
      prefix: [
        { kind: "session", provider_session_id: "schema_resolution_session" },
        { kind: "turn", provider_turn_id: "schema_resolution_turn" },
        { kind: "approval_required", approval_request_id: "schema_approval" },
      ],
    },
    {
      event: "reply",
      fields: { text: "schema reply" },
      prefix: [{ kind: "session", provider_session_id: "schema_reply_session" }],
    },
    {
      event: "completed_without_reply",
      fields: {},
      prefix: [{ kind: "session", provider_session_id: "schema_no_reply_session" }],
    },
    {
      event: "unsupported",
      fields: { reason_code: "unsupported_payload" },
      prefix: [{ kind: "session", provider_session_id: "schema_unsupported_session" }],
    },
    {
      event: "failed",
      fields: { reason_code: "provider_execution_failed" },
      prefix: [{ kind: "session", provider_session_id: "schema_failed_session" }],
    },
    {
      event: "cancelled",
      fields: { reason_code: "cancelled_during_safe_wait" },
      prefix: [{ kind: "session", provider_session_id: "schema_cancelled_session" }],
    },
    {
      event: "uncertain",
      fields: { reason_code: "provider_outcome_unknown" },
      prefix: [{ kind: "session", provider_session_id: "schema_uncertain_session" }],
    },
  ];
  const malformedSchemaScripts: K02ProviderStep[][] = [
    [{ kind: "malformed", value: null }],
    [{ kind: "malformed", value: { event: 7, execution_id: "wrong" } }],
    [{ kind: "malformed_for_execution", value: { event: "unknown_event" } }],
  ];
  for (const schema of eventSchemas) {
    const exact = { event: schema.event, ...schema.fields };
    malformedSchemaScripts.push(
      [...schema.prefix, { kind: "malformed", value: exact }],
      [...schema.prefix, { kind: "malformed", value: { ...exact, execution_id: 7 } }],
      [
        ...schema.prefix,
        { kind: "malformed", value: { ...exact, execution_id: "wrong_execution" } },
      ],
      [...schema.prefix, { kind: "malformed_for_execution", value: { ...exact, unknown: true } }],
    );
    for (const field of Object.keys(schema.fields)) {
      const missing: Record<string, unknown> = { ...exact };
      delete missing[field];
      malformedSchemaScripts.push(
        [...schema.prefix, { kind: "malformed_for_execution", value: missing }],
        [...schema.prefix, { kind: "malformed_for_execution", value: { ...exact, [field]: 7 } }],
      );
      if (field === "reason_code" || field === "decision") {
        malformedSchemaScripts.push([
          ...schema.prefix,
          { kind: "malformed_for_execution", value: { ...exact, [field]: "invalid_value" } },
        ]);
      }
    }
  }
  const invalidScripts: readonly (readonly K02ProviderStep[])[] = [
    ...malformedSchemaScripts,
    [{ kind: "no_reply" }],
    [{ kind: "failed", reason_code: "provider_execution_failed" }],
    [{ kind: "failed", reason_code: "provider_result_invalid" }],
    [
      { kind: "session", provider_session_id: "duplicate_session" },
      { kind: "session", provider_session_id: "duplicate_session" },
    ],
    [{ kind: "turn", provider_turn_id: "turn_before_session" }],
    [
      { kind: "session", provider_session_id: "session_after_progress" },
      { kind: "progress", text: "no-turn progress" },
      { kind: "turn", provider_turn_id: "late_turn" },
    ],
    [
      { kind: "session", provider_session_id: "session_after_approval" },
      { kind: "approval_required", approval_request_id: "approval_before_turn" },
      { kind: "turn", provider_turn_id: "late_turn" },
    ],
    [
      { kind: "session", provider_session_id: "session_duplicate_turn" },
      { kind: "turn", provider_turn_id: "turn_once" },
      { kind: "turn", provider_turn_id: "turn_twice" },
    ],
    [
      { kind: "session", provider_session_id: "session_bad_approval" },
      { kind: "turn", provider_turn_id: "turn_bad_approval" },
      { kind: "approval_resolved", approval_request_id: "never_requested", decision: "approved" },
    ],
    [
      { kind: "session", provider_session_id: "session_mismatch_approval" },
      { kind: "turn", provider_turn_id: "turn_mismatch_approval" },
      { kind: "approval_required", approval_request_id: "approval_expected" },
      {
        kind: "approval_resolved",
        approval_request_id: "approval_different",
        decision: "approved",
      },
    ],
    [
      { kind: "session", provider_session_id: "session_terminal_during_wait" },
      { kind: "turn", provider_turn_id: "turn_terminal_during_wait" },
      { kind: "approval_required", approval_request_id: "approval_still_waiting" },
      { kind: "reply", text: "terminal without cancellation" },
    ],
    [{ kind: "close" }],
    [{ kind: "session", provider_session_id: "session_then_close" }, { kind: "close" }],
    [
      { kind: "session", provider_session_id: "session_turn_then_close" },
      { kind: "turn", provider_turn_id: "turn_then_close" },
      { kind: "close" },
    ],
    [
      { kind: "session", provider_session_id: "session_approval_then_close" },
      { kind: "turn", provider_turn_id: "turn_approval_then_close" },
      { kind: "approval_required", approval_request_id: "approval_then_close" },
      { kind: "close" },
    ],
  ];
  for (const [index, script] of invalidScripts.entries()) {
    const scenario = await startK02Scenario(t, "K02-K03:P10", {
      scripts: [script],
    });
    const message = k02Message(`p10_message_${index}`, `p10_conversation_${index}`);
    scenario.enqueue(message);
    assert.equal((await scenario.wake(message.id)).status, 202);
    await scenario.connector.waitForIdle();
    assert.equal(scenario.provider.cancellations[0]?.reason, "contract_failure");
    assert.equal(scenario.gateway.tombstone(message.id)?.outcome, "uncertain");
    assert.deepEqual(scenario.gateway.calls.at(-2)?.arguments, {
      message_id: message.id,
      outcome: "uncertain",
      reason_code: "provider_outcome_unknown",
    });
  }

  for (const [index, cancelResult] of [
    null,
    {},
    { status: 7 },
    { status: "unknown" },
    { status: "cancel_requested", unknown: true },
  ].entries()) {
    const badCancel = await startK02Scenario(t, "K02-K03:P10", {
      cancelResult,
      scripts: [
        [
          { kind: "session", provider_session_id: `bad_cancel_session_${index}` },
          { kind: "turn", provider_turn_id: `bad_cancel_turn_${index}` },
          {
            kind: "malformed_for_execution",
            value: { event: "progress", text: "valid", unknown: true },
          },
        ],
      ],
    });
    const badCancelMessage = k02Message(
      `p10_bad_cancel_${index}`,
      `p10_bad_cancel_conversation_${index}`,
    );
    badCancel.enqueue(badCancelMessage);
    assert.equal((await badCancel.wake(badCancelMessage.id)).status, 202);
    await badCancel.connector.waitForIdle();
    assert.equal(badCancel.provider.cancellations[0]?.reason, "contract_failure");
    assert.equal(badCancel.providerPort.containmentAttempts, 1);
    assert.equal(badCancel.gateway.tombstone(badCancelMessage.id)?.outcome, "uncertain");
  }

  const sessionRecovery = await startK02Scenario(t, "K02-K03:P10", {
    crashForRecoveryState: "session_binding",
    scripts: [[{ kind: "session", provider_session_id: "p10_recovery_session" }]],
  });
  const sessionRecoveryMessage = k02Message(
    "p10_session_recovery",
    "p10_session_recovery_conversation",
  );
  sessionRecovery.enqueue(sessionRecoveryMessage);
  assert.equal((await sessionRecovery.wake(sessionRecoveryMessage.id)).status, 202);
  await assert.rejects(sessionRecovery.connector.waitForIdle(), /connector_test_crash/u);
  await sessionRecovery.connector.crash();
  const invalidSessionRecovery = await sessionRecovery.restart([
    [{ kind: "progress", text: "turn binding was required first" }],
  ]);
  await invalidSessionRecovery.connector.waitForIdle();
  assert.equal(invalidSessionRecovery.provider.requests[0]?.kind, "recover");
  assert.equal(invalidSessionRecovery.provider.cancellations[0]?.reason, "contract_failure");
  assert.equal(sessionRecovery.gateway.tombstone(sessionRecoveryMessage.id)?.outcome, "uncertain");

  const turnRecovery = await startK02Scenario(t, "K02-K03:P10", {
    crashAfter: "turn_published",
    scripts: [
      [
        { kind: "session", provider_session_id: "p10_turn_recovery_session" },
        { kind: "turn", provider_turn_id: "p10_turn_recovery_turn" },
      ],
    ],
  });
  const turnRecoveryMessage = k02Message("p10_turn_recovery", "p10_turn_recovery_conversation");
  turnRecovery.enqueue(turnRecoveryMessage);
  assert.equal((await turnRecovery.wake(turnRecoveryMessage.id)).status, 202);
  await assert.rejects(turnRecovery.connector.waitForIdle(), /connector_test_crash/u);
  await turnRecovery.connector.crash();
  const invalidTurnRecovery = await turnRecovery.restart([
    [{ kind: "session", provider_session_id: "late_recovery_session" }],
  ]);
  await invalidTurnRecovery.connector.waitForIdle();
  assert.equal(invalidTurnRecovery.provider.requests[0]?.kind, "recover");
  assert.equal(invalidTurnRecovery.provider.cancellations[0]?.reason, "contract_failure");
  assert.equal(turnRecovery.gateway.tombstone(turnRecoveryMessage.id)?.outcome, "uncertain");

  const approvalRecovery = await startK02Scenario(t, "K02-K03:P10", {
    crashForRecoveryState: "approval_wait",
    scripts: [
      [
        { kind: "session", provider_session_id: "p10_approval_recovery_session" },
        { kind: "turn", provider_turn_id: "p10_approval_recovery_turn" },
        { kind: "approval_required", approval_request_id: "p10_recovery_approval" },
      ],
    ],
  });
  const approvalRecoveryMessage = k02Message(
    "p10_approval_recovery",
    "p10_approval_recovery_conversation",
  );
  approvalRecovery.enqueue(approvalRecoveryMessage);
  assert.equal((await approvalRecovery.wake(approvalRecoveryMessage.id)).status, 202);
  await assert.rejects(approvalRecovery.connector.waitForIdle(), /connector_test_crash/u);
  await approvalRecovery.connector.crash();
  const invalidApprovalRecovery = await approvalRecovery.restart([
    [{ kind: "progress", text: "approval resolution was required first" }],
  ]);
  await invalidApprovalRecovery.connector.waitForIdle();
  assert.equal(invalidApprovalRecovery.provider.requests[0]?.kind, "recover");
  assert.equal(invalidApprovalRecovery.provider.cancellations[0]?.reason, "contract_failure");
  assert.equal(
    approvalRecovery.gateway.tombstone(approvalRecoveryMessage.id)?.outcome,
    "uncertain",
  );

  for (const recoveryState of ["uncertain", "outcome_open"] as const) {
    const terminalRecovery = await startK02Scenario(t, "K02-K03:P10", {
      crashForRecoveryState: recoveryState,
      gatewayProxy: recoveryState === "outcome_open",
      scripts: [
        [
          { kind: "session", provider_session_id: `p10_${recoveryState}_session` },
          { kind: "turn", provider_turn_id: `p10_${recoveryState}_turn` },
          ...(recoveryState === "uncertain"
            ? ([{ kind: "uncertain" }] as const)
            : ([{ kind: "reply", text: "lost open reply" }] as const)),
        ],
      ],
    });
    if (recoveryState === "outcome_open") {
      terminalRecovery.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
    }
    const terminalMessage = k02Message(`p10_${recoveryState}`, `p10_${recoveryState}_conversation`);
    terminalRecovery.enqueue(terminalMessage);
    assert.equal((await terminalRecovery.wake(terminalMessage.id)).status, 202);
    await assert.rejects(terminalRecovery.connector.waitForIdle(), /connector_test_crash/u);
    await terminalRecovery.connector.crash();
    const terminalRestart = await terminalRecovery.restart([
      recoveryState === "uncertain"
        ? [{ kind: "turn", provider_turn_id: "late_terminal_recovery_binding" }]
        : [{ kind: "no_reply" }],
    ]);
    await terminalRestart.connector.waitForIdle();
    assert.equal(terminalRestart.provider.requests.length, 1);
    assert.equal(terminalRestart.provider.requests[0]?.kind, "recover");
    assert.equal(terminalRestart.provider.cancellations[0]?.reason, "contract_failure");
    assert.equal(terminalRecovery.gateway.tombstone(terminalMessage.id)?.outcome, "uncertain");
    assert.equal(terminalRecovery.gateway.tombstone(terminalMessage.id)?.acknowledged, true);
  }

  for (const recoveryState of [
    "session_binding",
    "turn_running",
    "approval_wait",
    "uncertain",
    "outcome_open",
  ] as const) {
    const closeRecovery = await startK02Scenario(t, "K02-K03:P10", {
      ...(recoveryState === "turn_running"
        ? { crashAfter: "turn_published" as const }
        : { crashForRecoveryState: recoveryState }),
      gatewayProxy: recoveryState === "outcome_open",
      scripts: [
        [
          { kind: "session", provider_session_id: `p10_close_${recoveryState}_session` },
          ...(recoveryState === "session_binding"
            ? []
            : ([{ kind: "turn", provider_turn_id: `p10_close_${recoveryState}_turn` }] as const)),
          ...(recoveryState === "approval_wait"
            ? ([
                {
                  kind: "approval_required",
                  approval_request_id: "p10_close_recovery_approval",
                },
              ] as const)
            : recoveryState === "uncertain"
              ? ([{ kind: "uncertain" }] as const)
              : recoveryState === "outcome_open"
                ? ([{ kind: "reply", text: "p10 close lost reply" }] as const)
                : []),
        ],
      ],
    });
    if (recoveryState === "outcome_open") {
      closeRecovery.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
    }
    const closeMessage = k02Message(
      `p10_close_${recoveryState}`,
      `p10_close_${recoveryState}_conversation`,
    );
    closeRecovery.enqueue(closeMessage);
    assert.equal((await closeRecovery.wake(closeMessage.id)).status, 202);
    await assert.rejects(closeRecovery.connector.waitForIdle(), /connector_test_crash/u);
    await closeRecovery.connector.crash();
    const closeRestart = await closeRecovery.restart([[{ kind: "close" }]]);
    await closeRestart.connector.waitForIdle();
    assert.equal(closeRestart.provider.requests.length, 1);
    assert.equal(closeRestart.provider.requests[0]?.kind, "recover");
    assert.equal(closeRestart.provider.cancellations[0]?.reason, "contract_failure");
    assert.equal(closeRecovery.gateway.tombstone(closeMessage.id)?.outcome, "uncertain");
  }

  const postTerminal = await startK02Scenario(t, "K02-K03:P10", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_terminal" },
        { kind: "turn", provider_turn_id: "turn_terminal" },
        { kind: "reply", text: "one terminal reply" },
      ],
    ],
    postTerminalEvent: {
      event: "progress",
      execution_id: "must_not_be_observed",
      text: "post-terminal data",
    },
  });
  const message = k02Message("p10_post_terminal", "p10_post_terminal_conversation");
  postTerminal.enqueue(message);
  assert.equal((await postTerminal.wake(message.id)).status, 202);
  await postTerminal.connector.waitForIdle();
  assert.equal(postTerminal.providerPort.postTerminalDeliveries, 0);
  assert.equal(postTerminal.gateway.tombstone(message.id)?.outcome, "replied");
});
