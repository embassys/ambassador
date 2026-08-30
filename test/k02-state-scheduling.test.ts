import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { k02Message, startK02Scenario, waitFor } from "./support/connector/k02-production.js";

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function artifactBytes(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await stat(path);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) chunks.push(await readFile(path));
    }
  }
  await visit(root);
  return Buffer.concat(chunks);
}

test("K02-S04 persists only encrypted opaque mapping and content-free lifecycle data", async (t) => {
  const messageId = "message_state_sentinel_36b1";
  const conversationId = "conversation_state_sentinel_36b1";
  const sessionId = "provider_session_sentinel_36b1";
  const turnId = "provider_turn_sentinel_36b1";
  const prompt = "prompt-state-sentinel-36b1";
  const reply = "reply-state-sentinel-36b1";
  const scenario = await startK02Scenario(t, "K02-K03:S04", {
    scripts: [
      [
        { kind: "session", provider_session_id: sessionId },
        { kind: "turn", provider_turn_id: turnId },
        { kind: "reply", text: reply },
      ],
    ],
  });
  const message = k02Message(messageId, conversationId, prompt);
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();

  const database = new Database(join(scenario.stateDirectory, "correlation.sqlite3"), {
    readonly: true,
  });
  try {
    const conversation = database
      .prepare<[], { lifecycle: string; conversation_hmac: Buffer; provider_session_hmac: Buffer }>(
        "SELECT lifecycle, conversation_hmac, provider_session_hmac FROM conversations",
      )
      .get();
    assert.equal(conversation?.lifecycle, "active");
    assert.equal(conversation?.conversation_hmac.byteLength, 32);
    assert.equal(conversation?.provider_session_hmac.byteLength, 32);
    assert.equal(
      database.prepare<[], { count: number }>("SELECT count(*) AS count FROM messages").get()
        ?.count,
      0,
    );
  } finally {
    database.close();
  }

  const bytes = await artifactBytes(scenario.stateDirectory);
  for (const forbidden of [
    messageId,
    conversationId,
    sessionId,
    turnId,
    prompt,
    reply,
    scenario.workingDirectory,
  ]) {
    assert.ok(!bytes.includes(Buffer.from(forbidden, "utf8")), `persisted ${forbidden}`);
  }
});

test("K02-Q02 serializes one conversation and resumes its exact mapped session", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:Q02-conversation", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_linear" },
        { kind: "turn", provider_turn_id: "turn_linear_1" },
        { kind: "reply", text: "reply one" },
      ],
      [
        { kind: "turn", provider_turn_id: "turn_linear_2" },
        { kind: "reply", text: "reply two" },
      ],
    ],
  });
  const first = k02Message("message_linear_1", "conversation_linear", "first turn");
  scenario.enqueue(first);
  assert.equal((await scenario.wake(first.id)).status, 202);
  await scenario.connector.waitForIdle();

  const second = k02Message("message_linear_2", "conversation_linear", "second turn", first.id);
  scenario.enqueue(second);
  assert.equal((await scenario.wake(second.id)).status, 202);
  await scenario.connector.waitForIdle();

  assert.equal(scenario.provider.requests.length, 2);
  assert.equal(scenario.provider.requests[0]?.kind, "start");
  const resumed = scenario.provider.requests[1];
  assert.equal(resumed?.kind, "resume");
  if (resumed?.kind === "resume") assert.equal(resumed.provider_session_id, "session_linear");
  assert.equal(scenario.provider.activeExecutionCount, 0);
});

test("K02-Q02 holds at most two global turns and queues a third conversation", async (t) => {
  const waitingScript = (suffix: string) =>
    [
      { kind: "session", provider_session_id: `session_${suffix}` },
      { kind: "turn", provider_turn_id: `turn_${suffix}` },
      { kind: "wait_for_cancel" },
    ] as const;
  const scenario = await startK02Scenario(t, "K02-K03:Q02-global", {
    scripts: [waitingScript("a"), waitingScript("b")],
  });
  const first = k02Message("message_lane_1", "conversation_lane", "lane one");
  const secondConversation = k02Message("message_global_2", "conversation_global_2");
  const thirdConversation = k02Message("message_global_3", "conversation_global_3");
  for (const message of [first, secondConversation, thirdConversation]) {
    scenario.enqueue(message);
  }

  assert.equal((await scenario.wake(first.id)).status, 202);
  assert.equal((await scenario.wake(secondConversation.id)).status, 202);
  assert.equal((await scenario.wake(thirdConversation.id)).status, 202);
  await waitFor(() => scenario.provider.requests.length === 2, "two global provider turns");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(scenario.provider.activeExecutionCount, 2);
  assert.deepEqual(
    scenario.provider.requests.map((request) => request.message_id),
    [first.id, secondConversation.id],
  );
  assert.deepEqual(scenario.connector.inspectAdmissionStateForTest().queuedIds, [
    thirdConversation.id,
  ]);
});

test("K02-Q01 retains 100 queued opaque IDs and rejects entry 101 without eviction", async (t) => {
  const waitingScript = (suffix: string) =>
    [
      { kind: "session", provider_session_id: `session_capacity_${suffix}` },
      { kind: "turn", provider_turn_id: `turn_capacity_${suffix}` },
      { kind: "wait_for_cancel" },
    ] as const;
  const queuedIds = Array.from(
    { length: 100 },
    (_, index) => `queued_${String(index).padStart(3, "0")}`,
  );
  const queuedScripts = queuedIds.map((id) => [
    { kind: "session", provider_session_id: `session_${id}` } as const,
    { kind: "turn", provider_turn_id: `turn_${id}` } as const,
    { kind: "reply", text: `reply_${id}` } as const,
  ]);
  const scenario = await startK02Scenario(t, "K02-K03:Q01", {
    scripts: [waitingScript("one"), waitingScript("two"), ...queuedScripts],
  });
  const activeOne = k02Message("message_capacity_active_1", "conversation_capacity_active_1");
  const activeTwo = k02Message("message_capacity_active_2", "conversation_capacity_active_2");
  scenario.enqueue(activeOne);
  scenario.enqueue(activeTwo);
  for (const id of queuedIds.slice(0, 98)) {
    scenario.enqueue(k02Message(id, `conversation_${id}`));
  }
  assert.equal((await scenario.wake(activeOne.id)).status, 202);
  assert.equal((await scenario.wake(activeTwo.id)).status, 202);
  await waitFor(() => scenario.provider.activeExecutionCount === 2, "two occupied turn slots");

  for (const id of queuedIds) {
    assert.equal((await scenario.wake(id)).status, 202);
  }
  const rejected = await scenario.wake("queued_100");
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), { error: "connector_queue_full" });
  assert.equal(scenario.provider.requests.length, 2);

  for (const request of scenario.provider.requests) {
    await scenario.providerPort.cancel({
      kind: "cancel",
      execution_id: request.execution_id,
      provider_session_id: request.kind === "start" ? null : request.provider_session_id,
      provider_turn_id: null,
      reason: "shutdown",
    });
  }
  await waitFor(
    () =>
      scenario.gateway.tombstone(activeOne.id) !== undefined &&
      scenario.gateway.tombstone(activeTwo.id) !== undefined,
    "active messages acknowledged",
  );
  scenario.enqueue(k02Message(queuedIds[98] as string, `conversation_${queuedIds[98]}`));
  scenario.enqueue(k02Message(queuedIds[99] as string, `conversation_${queuedIds[99]}`));
  await scenario.connector.waitForIdle();
  assert.deepEqual(
    scenario.provider.requests.slice(2).map((request) => request.message_id),
    queuedIds,
  );
});

test("K02-Q03 stops independently when later work targets a closed conversation", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:Q03-closed", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_closed" },
        { kind: "unsupported", reason_code: "unsupported_payload" },
      ],
    ],
  });
  const closed = k02Message("q03_closed_first", "q03_closed_conversation");
  scenario.enqueue(closed);
  assert.equal((await scenario.wake(closed.id)).status, 202);
  await scenario.connector.waitForIdle();
  const laterClosed = k02Message("q03_closed_later", "q03_closed_conversation");
  scenario.enqueue(laterClosed);
  assert.equal((await scenario.wake(laterClosed.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_conversation_unavailable/u);
  assert.equal(scenario.provider.requests.length, 1);

  const malformedFailures: string[] = [];
  for (const field of [
    "id",
    "conversation_id",
    "sender_agent_id",
    "in_reply_to_message_id",
  ] as const) {
    try {
      const malformed = await startK02Scenario(t, "K02-K03:Q03-closed", { scripts: [] });
      const wakeId = `q03_non_string_${field}`;
      const rawMessage: Record<string, unknown> = {
        ...k02Message(wakeId, `q03_non_string_conversation_${field}`),
        [field]: 7,
      };
      malformed.gateway.setNextPollResultForTest({ messages: [rawMessage] });
      assert.equal((await malformed.wake(wakeId)).status, 202);
      await assert.rejects(
        malformed.connector.waitForIdle(),
        /connector_gateway_operation_failed/u,
      );
      assert.equal(malformed.provider.requests.length, 0);
      assert.deepEqual(malformed.gateway.calls.at(-1), {
        name: "poll_messages",
        arguments: { timeout: 0 },
      });
    } catch (error) {
      malformedFailures.push(`${field}: ${failureText(error)}`);
    }
  }
  assert.deepEqual(malformedFailures, [], malformedFailures.join("\n"));
});

test("K02-Q03 stops independently when later work targets an uncertain conversation", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:Q03-uncertain", {
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_uncertain_lane" },
        { kind: "turn", provider_turn_id: "turn_uncertain_lane" },
        { kind: "uncertain" },
      ],
    ],
  });
  scenario.gatewayProxy?.failNext("complete_message", { kind: "hold" });
  const uncertain = k02Message("q03_uncertain_first", "q03_uncertain_conversation");
  scenario.enqueue(uncertain);
  assert.equal((await scenario.wake(uncertain.id)).status, 202);
  await waitFor(
    () => scenario.gatewayProxy?.calls.some((call) => call.tool === "complete_message") ?? false,
    "unresolved uncertain terminal operation",
  );
  assert.equal(scenario.gateway.tombstone(uncertain.id), undefined);
  const laterUncertain = k02Message("q03_uncertain_later", "q03_uncertain_conversation");
  scenario.enqueue(laterUncertain);
  const pollsBeforeLaterWake =
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "poll_messages").length ?? 0;
  assert.equal((await scenario.wake(laterUncertain.id)).status, 202);
  try {
    await assert.rejects(scenario.connector.waitForIdle(), /connector_conversation_unavailable/u);
  } finally {
    scenario.gatewayProxy?.release("complete_message");
  }
  assert.equal(scenario.provider.requests.length, 1);
  const pollsAfterLaterWake =
    scenario.gatewayProxy?.calls.filter((call) => call.tool === "poll_messages") ?? [];
  assert.equal(pollsAfterLaterWake.length, pollsBeforeLaterWake + 1);
  assert.deepEqual(pollsAfterLaterWake.at(-1)?.arguments, { timeout: 0 });
  assert.equal(scenario.gateway.tombstone(laterUncertain.id), undefined);
});
