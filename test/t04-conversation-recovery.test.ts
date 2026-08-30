import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { parseCentralCredentialV2 } from "../src/credential-v2.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";
import { installT04FetchInterceptor, t04JsonResponse } from "./support/t04-fetch-interceptor.js";
import {
  requireT04Tool,
  restartT04Gateway,
  scanT04Artifacts,
  startInboundConversation,
  startT04GatewayScenario,
  T04_EMAIL,
  T04_MESSAGE_TEXT,
  T04_REPLY_TEXT,
  T04_USERNAME,
  T04_WEBHOOK_TOKEN,
  waitForLocalMessage,
} from "./support/t04-gateway-harness.js";
import { T04RawMcpClient } from "./support/t04-raw-mcp.js";
import { createInProcessV2FixtureClock } from "./support/v2-process-clock.js";
import { IndependentV2SenderClient } from "./support/v2-process-sender.js";

const START_PROPERTIES = ["payload", "recipient_username", "request_id"];
const REPLY_PROPERTIES = ["message_id", "payload"];
const COMPLETE_PROPERTIES = ["message_id", "outcome", "reason_code"];
const MESSAGE_ID_PROPERTIES = ["message_id"];

test("T04-P01 uses REST enrollment, DPoP transport, and activation before receive", async (t) => {
  let observedBearerAuthorization = false;
  installT04FetchInterceptor(t, async (request, call) => {
    observedBearerAuthorization ||=
      new URL(request.url).port !== "8787" &&
      (call.pathname.startsWith("/api/") || call.pathname === "/mcp") &&
      request.headers.get("authorization")?.startsWith("Bearer ") === true;
    return undefined;
  });
  const scenario = await startT04GatewayScenario(t);
  assert.equal(
    scenario.usedLegacyEnrollment,
    false,
    "[T04-P01] gateway still forwarded bootstrap through central MCP",
  );
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-P01");
  const pollTool = await requireT04Tool(scenario.client, "poll_messages", ["timeout"], "T04-P01");
  const pollProperties = pollTool.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(pollProperties.timeout?.maximum, 30);
  assert.equal(
    scenario.central.pollCount(),
    0,
    "[T04-P01] gateway used the version 1 consuming poll instead of activation and leased receive",
  );

  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040001");
  const wake = await scenario.webhook.waitForWake();
  assert.equal(wake.headers["idempotency-key"], inbound.messageId);
  assert.equal(JSON.stringify(wake.body).includes(T04_MESSAGE_TEXT), false);
  assert.equal(observedBearerAuthorization, false);
});

test("T04-C01 makes conversation start idempotent and lookup sender-owned", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-C01");
  await requireT04Tool(scenario.client, "get_conversation_start", ["request_id"], "T04-C01");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const requestId = "00000000-0000-4000-8000-000000040002";
  const input = {
    recipient_username: "fixture_recipient",
    payload: { text: "T04 start content must not enter gateway state 2e06c4." },
    request_id: requestId,
  };
  const first = await scenario.client.callTool("start_conversation", input);
  const repeated = await scenario.client.callTool("start_conversation", input);
  assert.deepEqual(repeated, first);
  assert.deepEqual(
    await scenario.client.callTool("get_conversation_start", { request_id: requestId }),
    {
      request_id: requestId,
      status: "accepted",
      message_id: first.message_id,
      conversation_id: first.conversation_id,
    },
  );
});

test("T04-D01 redelivers one immutable leased message after gateway restart", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-D01");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040003");
  await scenario.webhook.waitForWake();
  const first = await waitForLocalMessage(scenario.client, inbound.messageId);
  assert.equal((first.payload as Record<string, unknown>).text, T04_MESSAGE_TEXT);

  await scenario.gateway.stop();
  scenario.central.advanceClock(60);
  const restarted = await restartT04Gateway(t, scenario);
  const secondWake = await scenario.webhook.waitForWake();
  assert.equal(secondWake.headers["idempotency-key"], inbound.messageId);
  const redelivered = await waitForLocalMessage(restarted.client, inbound.messageId);
  assert.deepEqual(redelivered, first);
});

test("T04-R01 derives reply routing and provider projection from the inbound IDs", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-R01");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040004");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);

  const reply = await scenario.client.callTool("reply_message", {
    message_id: inbound.messageId,
    payload: { text: T04_REPLY_TEXT },
  });
  assert.equal(reply.conversation_id, inbound.conversationId);
  assert.equal(reply.status, "accepted");

  const sender = scenario.central.seedClient("fixture_sender");
  const received = await sender.request(
    `${scenario.central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(received.status, 200);
  const messages = ((await received.json()) as { messages: Array<Record<string, unknown>> })
    .messages;
  const projected = messages.find((message) => message.id === reply.message_id);
  assert.ok(projected !== undefined);
  assert.equal(projected.conversation_id, inbound.conversationId);
  assert.equal(projected.in_reply_to_message_id, inbound.messageId);
  assert.equal((projected.payload as Record<string, unknown>).text, T04_REPLY_TEXT);

  await scenario.client.callTool("ack_message", { message_id: inbound.messageId });
  const malformedInbound = await startInboundConversation(
    scenario,
    "00000000-0000-4000-8000-000000040099",
    `${T04_MESSAGE_TEXT} strict reply correlation`,
  );
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, malformedInbound.messageId);
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === `/api/v2/messages/${malformedInbound.messageId}/reply`
    ) {
      return t04JsonResponse(200, {
        message_id: malformedInbound.messageId,
        conversation_id: "wrong_conversation",
        status: "accepted",
      });
    }
    return undefined;
  });
  await assert.rejects(
    scenario.client.callTool("reply_message", {
      message_id: malformedInbound.messageId,
      payload: { text: T04_REPLY_TEXT },
    }),
    (error: unknown) => error instanceof McpCallError,
  );
});

test("T04-O01 records every terminal no-reply and failure completion idempotently", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-O01");
  await requireT04Tool(scenario.client, "ack_message", MESSAGE_ID_PROPERTIES, "T04-O01");
  const outcomes = [
    ["completed_without_reply", "no_reply_required"],
    ["unsupported", "unsupported_message_type"],
    ["unsupported", "unsupported_payload"],
    ["failed", "provider_start_failed"],
    ["failed", "provider_execution_failed"],
    ["failed", "provider_result_invalid"],
    ["cancelled", "cancelled_before_execution"],
    ["cancelled", "cancelled_during_safe_wait"],
    ["uncertain", "provider_outcome_unknown"],
  ] as const;
  for (const [index, [outcome, reasonCode]] of outcomes.entries()) {
    const inbound = await startInboundConversation(
      scenario,
      `00000000-0000-4000-8000-${(40_010 + index).toString().padStart(12, "0")}`,
      `${T04_MESSAGE_TEXT} ${index}`,
    );
    await scenario.webhook.waitForWake();
    await waitForLocalMessage(scenario.client, inbound.messageId);
    const input = { message_id: inbound.messageId, outcome, reason_code: reasonCode };
    const first = await scenario.client.callTool("complete_message", input);
    assert.deepEqual(await scenario.client.callTool("complete_message", input), first);
    assert.deepEqual(first, { message_id: inbound.messageId, outcome, status: "recorded" });
    await assert.rejects(
      scenario.client.callTool("complete_message", {
        message_id: inbound.messageId,
        outcome: outcome === "failed" ? "unsupported" : "failed",
        reason_code: outcome === "failed" ? "unsupported_payload" : "provider_result_invalid",
      }),
      (error: unknown) => error instanceof McpCallError,
    );
    await scenario.client.callTool("ack_message", { message_id: inbound.messageId });
  }

  const invalid = await startInboundConversation(
    scenario,
    "00000000-0000-4000-8000-000000040019",
    `${T04_MESSAGE_TEXT} invalid-pair`,
  );
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, invalid.messageId);
  await assert.rejects(
    scenario.client.callTool("complete_message", {
      message_id: invalid.messageId,
      outcome: "unsupported",
      reason_code: "provider_execution_failed",
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(scenario.central.v2MessageState(invalid.messageId).terminalOutcome, null);
});

test("T04-O02 lets the original sender observe a terminal no-reply outcome", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-O02");
  await requireT04Tool(scenario.client, "get_message_outcome", MESSAGE_ID_PROPERTIES, "T04-O02");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const started = await scenario.client.callTool("start_conversation", {
    recipient_username: "fixture_recipient",
    payload: { text: "T04 sender wait text must remain process-only 8c90f3." },
    request_id: "00000000-0000-4000-8000-000000040020",
  });
  const messageId = String(started.message_id);
  const recipient = scenario.central.seedClient("fixture_recipient");
  const received = await recipient.request(
    `${scenario.central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(received.status, 200);
  const receivedMessages = ((await received.json()) as { messages: Array<{ id: string }> })
    .messages;
  assert.ok(receivedMessages.some((message) => message.id === messageId));
  const completion = await recipient.request(
    `${scenario.central.apiUrl}/api/v2/messages/${messageId}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ outcome: "unsupported", reason_code: "unsupported_payload" }),
    },
  );
  assert.equal(completion.status, 200);
  const outcome = await scenario.client.callTool("get_message_outcome", {
    message_id: messageId,
  });
  assert.equal(outcome.status, "terminal");
  assert.equal(outcome.outcome, "unsupported");
  assert.equal(outcome.reply_message_id, null);
});

test("T04-R02 resolves a lost reply response without creating a second turn", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-R02");
  await requireT04Tool(scenario.client, "get_message_outcome", MESSAGE_ID_PROPERTIES, "T04-R02");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040022");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  scenario.central.failNextV2("reply", "drop_after_commit");
  await assert.rejects(
    scenario.client.callTool("reply_message", {
      message_id: inbound.messageId,
      payload: { text: T04_REPLY_TEXT },
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  const state = scenario.central.v2MessageState(inbound.messageId);
  assert.equal(state.terminalOutcome, "replied");
  assert.equal(typeof state.replyMessageId, "string");
  const outcome = await scenario.client.callTool("get_message_outcome", {
    message_id: inbound.messageId,
  });
  assert.equal(outcome.reply_message_id, state.replyMessageId);
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "GET" &&
      call.pathname === `/api/v2/messages/${inbound.messageId}/outcome`
    ) {
      return t04JsonResponse(200, {
        message_id: inbound.messageId,
        conversation_id: inbound.conversationId,
        status: "terminal",
        outcome: "replied",
        reply_message_id: inbound.messageId,
      });
    }
    return undefined;
  });
  await assert.rejects(
    scenario.client.callTool("get_message_outcome", { message_id: inbound.messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
});

test("T04-A01 repeats acknowledgement after a lost committed response", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "ack_message", MESSAGE_ID_PROPERTIES, "T04-A01");
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-A01");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040021");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  await scenario.client.callTool("complete_message", {
    message_id: inbound.messageId,
    outcome: "completed_without_reply",
    reason_code: "no_reply_required",
  });
  scenario.central.failNextV2("ack", "drop_after_commit");
  await assert.rejects(
    scenario.client.callTool("ack_message", { message_id: inbound.messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
  await scenario.gateway.stop();
  let releaseReceive: ((response: Response) => void) | undefined;
  const heldReceive = new Promise<Response>((resolve) => {
    releaseReceive = resolve;
  });
  let markReceiveStarted: (() => void) | undefined;
  const receiveStarted = new Promise<void>((resolve) => {
    markReceiveStarted = resolve;
  });
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "GET" &&
      call.pathname === "/api/v2/messages/receive"
    ) {
      markReceiveStarted?.();
      return await heldReceive;
    }
    return undefined;
  });
  t.after(() => releaseReceive?.(t04JsonResponse(200, { messages: [] })));
  const restarted = await restartT04Gateway(t, scenario);
  await receiveStarted;
  assert.deepEqual(
    await restarted.client.callTool("ack_message", { message_id: inbound.messageId }),
    { message_id: inbound.messageId, status: "acked" },
  );
  releaseReceive?.(
    t04JsonResponse(200, {
      messages: [
        {
          id: inbound.messageId,
          conversation_id: inbound.conversationId,
          sender_agent_id: "fixture_sender_agent",
          message_type: "conversation_turn",
          in_reply_to_message_id: null,
          payload: { text: T04_MESSAGE_TEXT },
          created_at: new Date(scenario.central.clock() * 1_000).toISOString(),
        },
      ],
    }),
  );
  await delay(25);
  assert.deepEqual(await restarted.client.callTool("poll_messages", { timeout: 0 }), {
    messages: [],
  });
  assert.equal(scenario.central.v2MessageState(inbound.messageId).acknowledged, true);
});

test("T04-E01 does not reflect authorization, non-enumeration, or rate-limit inputs", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-E01");
  await requireT04Tool(scenario.client, "get_message_outcome", MESSAGE_ID_PROPERTIES, "T04-E01");
  const rawClient = new T04RawMcpClient(scenario.gateway.endpoint, T04_WEBHOOK_TOKEN);
  await rawClient.initialize();
  const deniedInput = {
    payload: { text: "T04 denied content must not be reflected 1b3c56." },
  };
  const nonOpted = new IndependentV2SenderClient({
    apiOrigin: scenario.central.apiUrl,
    clock: createInProcessV2FixtureClock(scenario.central),
    keyScalar: 904,
    firstProofSequence: 904_000,
  });
  await nonOpted.enroll({
    email: "t04-non-opted@fixture.invalid",
    username: "t04_non_opted",
    code: "123456",
  });
  scenario.central.setConversationGrant("t04_non_opted", T04_USERNAME, true);
  const recipients = ["absent_t04", "fixture_denied", "t04_non_opted"];
  const recipientErrors = [];
  for (const [index, recipient] of recipients.entries()) {
    recipientErrors.push(
      await rawClient.callToolError("start_conversation", {
        ...deniedInput,
        recipient_username: recipient,
        request_id: `00000000-0000-4000-8000-${(40_030 + index).toString().padStart(12, "0")}`,
      }),
    );
  }
  assert.deepEqual(recipientErrors, [recipientErrors[0], recipientErrors[0], recipientErrors[0]]);
  assert.deepEqual(recipientErrors[0]?.data, {
    code: "recipient_unavailable",
    retry_after_ms: null,
  });
  const foreignError = await rawClient.callToolError("get_message_outcome", {
    message_id: "foreign_message_040030",
  });
  assert.deepEqual(foreignError.data, { code: "message_not_found", retry_after_ms: null });

  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const delays = [1, 1_001, 60_000];
  const retryAfter = ["1", "2", "60"];
  let rateIndex = 0;
  const interceptor = installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin !== scenario.central.apiUrl ||
      call.method !== "POST" ||
      call.pathname !== "/api/v2/conversations"
    ) {
      return undefined;
    }
    const index = rateIndex;
    rateIndex += 1;
    return t04JsonResponse(
      429,
      { error: { code: "rate_limited", retry_after_ms: delays[index] } },
      { "retry-after": retryAfter[index] ?? "invalid" },
    );
  });
  for (const [index, retryAfterMs] of delays.entries()) {
    const error = await rawClient.callToolError("start_conversation", {
      ...deniedInput,
      recipient_username: "fixture_recipient",
      request_id: `00000000-0000-4000-8000-${(40_031 + index).toString().padStart(12, "0")}`,
    });
    assert.deepEqual(error.data, { code: "rate_limited", retry_after_ms: retryAfterMs });
  }
  assert.equal(rateIndex, 3);
  assert.deepEqual(
    interceptor.calls
      .filter(
        (call) =>
          call.origin === scenario.central.apiUrl &&
          call.method === "POST" &&
          call.pathname === "/api/v2/conversations",
      )
      .map((call) => `${call.method} ${call.pathname}${call.search}`),
    ["POST /api/v2/conversations", "POST /api/v2/conversations", "POST /api/v2/conversations"],
  );
  const transcript = `${scenario.gateway.stdout()}${scenario.gateway.stderr()}`;
  assert.equal(transcript.includes("fixture_denied"), false);
  assert.equal(transcript.includes("foreign_message_040030"), false);
  assert.equal(transcript.includes("1b3c56"), false);
});

test("T04-B01 bounds concurrent local work and cancels a wait during shutdown", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-B01");
  const clients = Array.from(
    { length: 12 },
    () => new TestMcpClient(scenario.gateway.endpoint, T04_WEBHOOK_TOKEN),
  );
  await Promise.all(clients.map(async (client) => await client.initialize()));
  let rejectedBeforeShutdown = 0;
  const waits = clients.map(async (client) => {
    try {
      return await client.callTool("poll_messages", { timeout: 30 });
    } catch (error) {
      rejectedBeforeShutdown += 1;
      throw error;
    }
  });
  const allSettled = Promise.allSettled(waits);
  const admissionDeadline = Date.now() + 1_000;
  while (rejectedBeforeShutdown < 4 && Date.now() < admissionDeadline) await delay(1);
  assert.ok(
    rejectedBeforeShutdown >= 4,
    "gateway admitted more than eight concurrent local tool calls",
  );
  const started = Date.now();
  const stopping = scenario.gateway.stop();
  const settled = await allSettled;
  assert.ok(Date.now() - started < 2_000, "gateway shutdown exceeded the test bound");
  assert.ok(settled.some((result) => result.status === "rejected"));
  assert.equal(await stopping, 0);
});

test("T04-S01 leaves artifacts and normal transcripts free of conversation content", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-S01");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040040");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  await scenario.client.callTool("reply_message", {
    message_id: inbound.messageId,
    payload: { text: T04_REPLY_TEXT },
  });
  await scenario.gateway.stop();
  const oldAccessToken = scenario.central.currentV2Token(T04_USERNAME);
  scenario.central.advanceClock(43_201);
  t.mock.timers.enable({ apis: ["Date"], now: scenario.central.clock() * 1_000 });
  let releaseReissue: (() => void) | undefined;
  const reissueGate = new Promise<void>((resolve) => {
    releaseReissue = resolve;
  });
  let markReissueStarted: (() => void) | undefined;
  const reissueStarted = new Promise<void>((resolve) => {
    markReissueStarted = resolve;
  });
  let releaseReceive: ((response: Response) => void) | undefined;
  const heldReceive = new Promise<Response>((resolve) => {
    releaseReceive = resolve;
  });
  let markReceiveStarted: (() => void) | undefined;
  const receiveStarted = new Promise<void>((resolve) => {
    markReceiveStarted = resolve;
  });
  installT04FetchInterceptor(t, async (_request, call, forward) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === "/api/v2/token/reissue"
    ) {
      markReissueStarted?.();
      await reissueGate;
      return await forward();
    }
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "GET" &&
      call.pathname === "/api/v2/messages/receive"
    ) {
      markReceiveStarted?.();
      return await heldReceive;
    }
    return undefined;
  });
  t.after(() => {
    releaseReissue?.();
    releaseReceive?.(t04JsonResponse(200, { messages: [] }));
  });
  const restarted = await restartT04Gateway(t, scenario);
  await Promise.all([reissueStarted, receiveStarted]);
  releaseReissue?.();
  let newAccessToken = oldAccessToken;
  for (let turn = 0; turn < 2_000 && newAccessToken === oldAccessToken; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    newAccessToken = scenario.central.currentV2Token(T04_USERNAME);
  }
  assert.equal(newAccessToken === oldAccessToken, false, "same-key reissue did not complete");
  const persistedCredentialStore = new EncryptedFileCredentialStore(
    join(scenario.gateway.stateRoot, "central-credential.json"),
    T04_WEBHOOK_TOKEN,
    JSON.stringify({
      centralApiUrl: new URL(scenario.central.apiUrl).href,
      centralMcpUrl: new URL(scenario.central.mcpUrl).href,
    }),
  );
  let newCredentialPublished = false;
  for (let turn = 0; turn < 2_000 && !newCredentialPublished; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const persisted = await persistedCredentialStore.loadCredential();
    newCredentialPublished =
      persisted?.version === 2 &&
      parseCentralCredentialV2(persisted.plaintext).record.access_token === newAccessToken;
  }
  assert.equal(
    newCredentialPublished,
    true,
    "same-key reissue was not published after persistence",
  );
  releaseReceive?.(
    t04JsonResponse(200, {
      messages: [
        {
          id: "t04_reissue_reflection_message",
          conversation_id: "t04_reissue_reflection_conversation",
          sender_agent_id: "fixture_sender_agent",
          message_type: "conversation_turn",
          in_reply_to_message_id: null,
          payload: { text: newAccessToken },
          created_at: new Date(scenario.central.clock() * 1_000).toISOString(),
        },
      ],
    }),
  );
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const local = await restarted.client.callTool("poll_messages", { timeout: 0 });
  assert.equal(Array.isArray(local.messages) ? local.messages.length : -1, 0);
  await restarted.gateway.stop();
  await scanT04Artifacts({
    root: scenario.gateway.artifactRoot,
    stdout: `${scenario.gateway.stdout()}${restarted.gateway.stdout()}`,
    stderr: `${scenario.gateway.stderr()}${restarted.gateway.stderr()}`,
    markers: [
      { name: "webhook-token", value: T04_WEBHOOK_TOKEN },
      { name: "enrollment-email", value: T04_EMAIL },
      { name: "verification-code", value: "123456" },
      { name: "legacy-code", value: "246810" },
      { name: "message-text", value: T04_MESSAGE_TEXT },
      { name: "reply-text", value: T04_REPLY_TEXT },
      { name: "old-access-token", value: oldAccessToken },
      { name: "new-access-token", value: newAccessToken },
    ],
  });
});
