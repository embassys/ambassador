import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { McpCallError } from "./support/mcp-client.js";
import { installT04FetchInterceptor, t04JsonResponse } from "./support/t04-fetch-interceptor.js";
import {
  requireT04Tool,
  startInboundConversation,
  startT04GatewayScenario,
  T04_MESSAGE_TEXT,
  T04_REPLY_TEXT,
  T04_USERNAME,
  T04_WEBHOOK_TOKEN,
  waitForLocalMessage,
} from "./support/t04-gateway-harness.js";
import { T04RawMcpClient } from "./support/t04-raw-mcp.js";

const START_PROPERTIES = ["payload", "recipient_username", "request_id"];
const REPLY_PROPERTIES = ["message_id", "payload"];
const COMPLETE_PROPERTIES = ["message_id", "outcome", "reason_code"];
const MESSAGE_ID_PROPERTIES = ["message_id"];

function journalContains(stateRoot: string, messageId: string): boolean {
  const database = new Database(join(stateRoot, "notifications.sqlite"), { readonly: true });
  try {
    const row = database
      .prepare<[string], { present: number }>(
        "SELECT EXISTS (SELECT 1 FROM notification_relay WHERE message_id = ?) AS present",
      )
      .get(messageId);
    return row?.present === 1;
  } finally {
    database.close();
  }
}

test("T04-V01 repeats fresh-install activation after a lost committed response", async (t) => {
  const scenario = await startT04GatewayScenario(t, {
    beforeVerification: (central) => {
      central.failNextV2("activate", "temporarily_unavailable");
      central.failNextV2("activate", "drop_after_commit");
    },
  });
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-V01");
  assert.equal(scenario.central.pollCount(), 0);
});

test("T04-C02 resolves uncertain starts and rejects changed idempotent input", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-C02");
  await requireT04Tool(scenario.client, "get_conversation_start", ["request_id"], "T04-C02");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const requestId = "00000000-0000-4000-8000-000000040101";
  const input = {
    recipient_username: "fixture_recipient",
    payload: { text: "T04 uncertain start content stays transient 215bf0." },
    request_id: requestId,
  };
  scenario.central.failNextV2("start", "drop_after_commit");
  await assert.rejects(
    scenario.client.callTool("start_conversation", input),
    (error: unknown) => error instanceof McpCallError,
  );
  const recorded = await scenario.client.callTool("get_conversation_start", {
    request_id: requestId,
  });
  assert.equal(recorded.status, "accepted");
  assert.deepEqual(await scenario.client.callTool("start_conversation", input), {
    message_id: recorded.message_id,
    conversation_id: recorded.conversation_id,
    status: "accepted",
  });
  await assert.rejects(
    scenario.client.callTool("start_conversation", {
      ...input,
      payload: { text: "changed" },
    }),
    (error: unknown) => error instanceof McpCallError,
  );

  const notFoundId = "00000000-0000-4000-8000-000000040102";
  assert.deepEqual(
    await scenario.client.callTool("get_conversation_start", { request_id: notFoundId }),
    {
      request_id: notFoundId,
      status: "not_found",
      message_id: null,
      conversation_id: null,
    },
  );
});

test("T04-C03 rejects strict start bounds before central application work", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-C03");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  let centralStartCalls = 0;
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === "/api/v2/conversations"
    ) {
      centralStartCalls += 1;
    }
    return undefined;
  });
  scenario.central.failNextV2("start", "temporarily_unavailable");
  await assert.rejects(
    scenario.client.callTool("start_conversation", {
      recipient_username: "fixture_recipient",
      payload: { text: "valid", unknown: true },
      request_id: "00000000-0000-4000-8000-000000040103",
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  await assert.rejects(
    scenario.client.callTool("start_conversation", {
      recipient_username: "fixture_recipient",
      payload: { text: "x".repeat(262_145) },
      request_id: "00000000-0000-4000-8000-000000040104",
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  await assert.rejects(
    scenario.client.callTool("start_conversation", {
      recipient_username: "fixture_recipient",
      payload: { text: "\0".repeat(100_000) },
      request_id: "00000000-0000-4000-8000-000000040106",
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(centralStartCalls, 0);
  await assert.rejects(
    scenario.client.callTool("start_conversation", {
      recipient_username: "fixture_recipient",
      payload: { text: "valid" },
      request_id: "00000000-0000-4000-8000-000000040105",
    }),
    (error: unknown) => error instanceof McpCallError,
  );
});

test("T04-R03 repeats one reply, rejects changed text, and preserves one outbound ID", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-R03");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040110");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  let centralReplyCalls = 0;
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === `/api/v2/messages/${inbound.messageId}/reply`
    ) {
      centralReplyCalls += 1;
    }
    return undefined;
  });
  await assert.rejects(
    scenario.client.callTool("reply_message", {
      message_id: inbound.messageId,
      payload: { text: "\0".repeat(100_000) },
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(centralReplyCalls, 0);
  const input = { message_id: inbound.messageId, payload: { text: T04_REPLY_TEXT } };
  const first = await scenario.client.callTool("reply_message", input);
  assert.deepEqual(await scenario.client.callTool("reply_message", input), first);
  await assert.rejects(
    scenario.client.callTool("reply_message", {
      message_id: inbound.messageId,
      payload: { text: `${T04_REPLY_TEXT} changed` },
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(scenario.central.v2MessageState(inbound.messageId).replyMessageId, first.message_id);
});

test("T04-R04 leaves the inbound turn open when the sender mailbox is full", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-R04");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040111");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  const interceptor = installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === `/api/v2/messages/${inbound.messageId}/reply`
    ) {
      return t04JsonResponse(429, {
        error: { code: "mailbox_full", retry_after_ms: null },
      });
    }
    return undefined;
  });
  await assert.rejects(
    scenario.client.callTool("reply_message", {
      message_id: inbound.messageId,
      payload: { text: T04_REPLY_TEXT },
    }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(scenario.central.v2MessageState(inbound.messageId).terminalOutcome, null);
  assert.equal(
    interceptor.calls.filter((call) => call.pathname.endsWith(`/${inbound.messageId}/reply`))
      .length,
    1,
  );
  const buffered = await waitForLocalMessage(scenario.client, inbound.messageId);
  assert.equal((buffered.payload as Record<string, unknown>).text, T04_MESSAGE_TEXT);
});

test("T04-O03 makes a reply-completion race choose one terminal result", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "reply_message", REPLY_PROPERTIES, "T04-O03");
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-O03");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040112");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  const results = await Promise.allSettled([
    scenario.client.callTool("reply_message", {
      message_id: inbound.messageId,
      payload: { text: T04_REPLY_TEXT },
    }),
    scenario.client.callTool("complete_message", {
      message_id: inbound.messageId,
      outcome: "failed",
      reason_code: "provider_execution_failed",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.notEqual(scenario.central.v2MessageState(inbound.messageId).terminalOutcome, null);
});

test("T04-A02 rejects acknowledgement before terminal state and deletes only after exact ack", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "ack_message", MESSAGE_ID_PROPERTIES, "T04-A02");
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-A02");
  const inbound = await startInboundConversation(scenario, "00000000-0000-4000-8000-000000040113");
  await scenario.webhook.waitForWake();
  await waitForLocalMessage(scenario.client, inbound.messageId);
  assert.equal(journalContains(scenario.gateway.stateRoot, inbound.messageId), true);
  await assert.rejects(
    scenario.client.callTool("ack_message", { message_id: inbound.messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(scenario.central.v2MessageState(inbound.messageId).acknowledged, false);
  assert.equal(journalContains(scenario.gateway.stateRoot, inbound.messageId), true);
  await waitForLocalMessage(scenario.client, inbound.messageId);
  await scenario.client.callTool("complete_message", {
    message_id: inbound.messageId,
    outcome: "completed_without_reply",
    reason_code: "no_reply_required",
  });
  await waitForLocalMessage(scenario.client, inbound.messageId);
  assert.equal(journalContains(scenario.gateway.stateRoot, inbound.messageId), true);
  const interceptor = installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === `/api/v2/messages/${inbound.messageId}/ack`
    ) {
      return t04JsonResponse(200, { message_id: "different_message", status: "acked" });
    }
    return undefined;
  });
  await assert.rejects(
    scenario.client.callTool("ack_message", { message_id: inbound.messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
  assert.equal(scenario.central.v2MessageState(inbound.messageId).acknowledged, false);
  assert.equal(journalContains(scenario.gateway.stateRoot, inbound.messageId), true);
  await waitForLocalMessage(scenario.client, inbound.messageId);
  interceptor.restore();
  let upstreamAckCalls = 0;
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin === scenario.central.apiUrl &&
      call.method === "POST" &&
      call.pathname === `/api/v2/messages/${inbound.messageId}/ack`
    ) {
      upstreamAckCalls += 1;
    }
    return undefined;
  });
  const discarded = new T04RawMcpClient(scenario.gateway.endpoint, T04_WEBHOOK_TOKEN);
  await discarded.initialize();
  await discarded.callToolAndDiscardResponse("ack_message", { message_id: inbound.messageId });
  const repeated = await Promise.all([
    scenario.client.callTool("ack_message", { message_id: inbound.messageId }),
    scenario.client.callTool("ack_message", { message_id: inbound.messageId }),
  ]);
  assert.deepEqual(repeated, [
    { message_id: inbound.messageId, status: "acked" },
    { message_id: inbound.messageId, status: "acked" },
  ]);
  assert.equal(upstreamAckCalls, 3);
  assert.equal(scenario.central.v2MessageState(inbound.messageId).acknowledged, true);
  assert.equal(journalContains(scenario.gateway.stateRoot, inbound.messageId), false);
  assert.deepEqual(await scenario.client.callTool("poll_messages", { timeout: 0 }), {
    messages: [],
  });
});
