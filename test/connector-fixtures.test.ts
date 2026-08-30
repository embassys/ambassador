import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import {
  CONNECTOR_DELIVERY_TOOL_DEFINITIONS,
  CONNECTOR_DELIVERY_TOOLS,
  CONNECTOR_WAKE_DEADLINE_MS,
  type FakeGatewayMessage,
  FakeProviderExitedError,
  type FakeProviderInvocation,
  type ProviderCancelRequest,
  type ProviderRecoverRequest,
  type ProviderStartRequest,
  startFakeConnectorGateway,
  startScriptedFakeProvider,
} from "./support/connector/index.js";
import { TestMcpClient } from "./support/mcp-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_POLL_RESULT_BYTES = 524_288;

function message(
  id: string,
  conversationId: string,
  text = "fixture input stays in memory",
): FakeGatewayMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_agent_id: "fixture_sender",
    message_type: "conversation_turn",
    in_reply_to_message_id: null,
    payload: { text },
    created_at: "2026-08-30T12:00:00.000Z",
  };
}

function startRequest(executionId: string, inputText = "fixture input"): ProviderStartRequest {
  return {
    kind: "start",
    execution_id: executionId,
    conversation_id: `conversation_${executionId.at(-1)}`,
    message_id: `message_${executionId.at(-1)}`,
    input_text: inputText,
    deadline_unix_ms: 1_788_000_900_000,
  };
}

async function collect(invocation: FakeProviderInvocation): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of invocation) events.push(event);
  return events;
}

function expectedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function expectedToolDefinitions(): Record<string, unknown>[] {
  const id = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._~-]+$",
  };
  const tool = (
    name: string,
    properties: Record<string, unknown>,
    required: string[],
  ): Record<string, unknown> => ({
    name,
    description: `${name} connector fixture tool`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  });
  return [
    tool("poll_messages", { timeout: { type: "integer", minimum: 0, maximum: 30 } }, ["timeout"]),
    tool(
      "reply_message",
      {
        message_id: id,
        payload: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 262_144 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      ["message_id", "payload"],
    ),
    tool(
      "complete_message",
      {
        message_id: id,
        outcome: {
          type: "string",
          enum: ["completed_without_reply", "unsupported", "failed", "cancelled", "uncertain"],
        },
        reason_code: {
          type: "string",
          enum: [
            "no_reply_required",
            "unsupported_message_type",
            "unsupported_payload",
            "provider_start_failed",
            "provider_execution_failed",
            "provider_result_invalid",
            "cancelled_before_execution",
            "cancelled_during_safe_wait",
            "provider_outcome_unknown",
          ],
        },
      },
      ["message_id", "outcome", "reason_code"],
    ),
    tool("get_message_outcome", { message_id: id }, ["message_id"]),
    tool("ack_message", { message_id: id }, ["message_id"]),
  ];
}

async function startWakeReceiver(t: TestContext): Promise<{
  url: string;
  received: Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>;
}> {
  let resolveWake:
    | ((value: { headers: Record<string, string | string[] | undefined>; body: Buffer }) => void)
    | undefined;
  const received = new Promise<{
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve) => {
    resolveWake = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolveWake?.({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"status":"accepted"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/webhook`, received };
}

test("the connector gateway fixture authenticates MCP and publishes exact closed tools", async (t) => {
  const gateway = await startFakeConnectorGateway(t, { token: TOKEN });
  const rejected = await fetch(gateway.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${"f".repeat(48)}`,
      "content-type": "application/json",
    },
    body: "{not-json",
  });
  assert.equal(rejected.status, 401);
  assert.equal(gateway.rejectedBeforeBodyCount, 1);

  const client = new TestMcpClient(gateway.endpoint, TOKEN);
  await client.initialize();
  const expectedTools = expectedToolDefinitions();
  assert.deepEqual(CONNECTOR_DELIVERY_TOOL_DEFINITIONS, expectedTools);
  const tools = await client.listTools();
  assert.deepEqual(tools, expectedTools);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    CONNECTOR_DELIVERY_TOOLS,
  );

  const first = message("fixture_message_1", "fixture_conversation_1");
  gateway.enqueueMessage(first);
  assert.deepEqual(await client.callTool("poll_messages", { timeout: 0 }), {
    messages: [first],
  });
  const replyText = "fixture reply stays in memory only until acknowledgement";
  assert.deepEqual(
    await client.callTool("reply_message", {
      message_id: first.id,
      payload: { text: replyText },
    }),
    {
      message_id: "fixture_reply_1",
      conversation_id: first.conversation_id,
      status: "accepted",
    },
  );
  assert.deepEqual(await client.callTool("get_message_outcome", { message_id: first.id }), {
    message_id: first.id,
    conversation_id: first.conversation_id,
    status: "terminal",
    outcome: "replied",
    reply_message_id: "fixture_reply_1",
  });
  assert.ok(gateway.rawContentBytes > 0);
  assert.deepEqual(await client.callTool("ack_message", { message_id: first.id }), {
    message_id: first.id,
    status: "acked",
  });
  assert.equal(gateway.rawContentBytes, 0);
  assert.deepEqual(gateway.tombstone(first.id), {
    message_id: first.id,
    conversation_id: first.conversation_id,
    outcome: "replied",
    reply_message_id: "fixture_reply_1",
    acknowledged: true,
  });
  assert.ok(!JSON.stringify(gateway.tombstone(first.id)).includes(first.payload.text));
  assert.ok(!JSON.stringify(gateway.calls).includes(replyText));

  const second = message("fixture_message_2", "fixture_conversation_2");
  gateway.enqueueMessage(second);
  assert.deepEqual(
    await client.callTool("complete_message", {
      message_id: second.id,
      outcome: "completed_without_reply",
      reason_code: "no_reply_required",
    }),
    { message_id: second.id, outcome: "completed_without_reply", status: "recorded" },
  );
  assert.deepEqual(await client.callTool("ack_message", { message_id: second.id }), {
    message_id: second.id,
    status: "acked",
  });
  assert.equal(gateway.rawContentBytes, 0);
  assert.deepEqual(
    [...new Set(gateway.calls.map((call) => call.name))].sort(),
    [...CONNECTOR_DELIVERY_TOOLS].sort(),
  );
});

test("the gateway fixture enforces message count, text, and normalized result bytes", async (t) => {
  const countGateway = await startFakeConnectorGateway(t, { token: TOKEN });
  for (let index = 0; index < 100; index += 1) {
    countGateway.enqueueMessage(message(`count_${index}`, `conversation_${index}`, "x"));
  }
  assert.throws(() => countGateway.enqueueMessage(message("count_100", "conversation_100", "x")));

  const byteGateway = await startFakeConnectorGateway(t, { token: TOKEN });
  const first = message("byte_first", "byte_conversation_1", "x".repeat(262_144));
  const emptySecond = message("byte_second", "byte_conversation_2", "");
  const fixedBytes = Buffer.byteLength(JSON.stringify({ messages: [first, emptySecond] }), "utf8");
  const secondTextBytes = MAX_POLL_RESULT_BYTES - fixedBytes;
  assert.ok(secondTextBytes >= 1 && secondTextBytes <= 262_144);
  const second = message("byte_second", "byte_conversation_2", "x".repeat(secondTextBytes));
  byteGateway.enqueueMessage(first);
  byteGateway.enqueueMessage(second);
  assert.equal(byteGateway.pollResultBytes, MAX_POLL_RESULT_BYTES);
  assert.throws(() =>
    byteGateway.enqueueMessage(message("byte_excess", "byte_conversation_3", "x")),
  );
  assert.throws(() =>
    byteGateway.enqueueMessage(message("text_excess", "byte_conversation_4", "x".repeat(262_145))),
  );
});

test("the gateway fixture signs an ID-only wake with a fixed abort deadline", async (t) => {
  const gateway = await startFakeConnectorGateway(t, { token: TOKEN });
  const receiver = await startWakeReceiver(t);
  const messageId = "fixture_wake_1";
  assert.equal(CONNECTOR_WAKE_DEADLINE_MS, 10_000);
  const response = await gateway.sendWake(receiver.url, messageId, {
    timestampSeconds: 1_788_000_000,
  });
  assert.equal(response.status, 202);

  const wake = await receiver.received;
  assert.equal(wake.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(wake.headers["idempotency-key"], messageId);
  assert.equal(wake.headers["x-request-id"], messageId);
  assert.equal(wake.headers["x-webhook-timestamp"], "1788000000");
  const expectedSignature = createHmac("sha256", TOKEN)
    .update("1788000000", "ascii")
    .update(".", "ascii")
    .update(wake.body)
    .digest("hex");
  assert.equal(wake.headers["x-webhook-signature-v2"], expectedSignature);
  assert.deepEqual(JSON.parse(wake.body.toString("utf8")), {
    message: `A2A message ${messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
    name: "A2A Gateway",
    deliver: false,
    wakeMode: "now",
  });
});

test("the provider fixture emits one event per pull and scripts recovery and bounds", async (t) => {
  const provider = startScriptedFakeProvider(t);
  const start = startRequest("00000000-0000-4000-8000-000000000001", "forbidden_provider_sentinel");
  const invocation = provider.invoke(start, [
    { kind: "session", provider_session_id: "fixture_session_1" },
    { kind: "turn", provider_turn_id: "fixture_turn_1" },
    { kind: "progress", text: "fixture progress" },
    { kind: "approval_required", approval_request_id: "fixture_approval_1" },
    {
      kind: "approval_resolved",
      approval_request_id: "fixture_approval_1",
      decision: "denied",
    },
    { kind: "reply", text: "fixture reply" },
  ]);
  assert.deepEqual(provider.pulls, []);
  assert.deepEqual(await invocation.next(), {
    done: false,
    value: {
      event: "session_bound",
      execution_id: start.execution_id,
      provider_session_id: "fixture_session_1",
    },
  });
  assert.deepEqual(provider.pulls, [start.execution_id]);
  assert.deepEqual(await collect(invocation), [
    {
      event: "turn_bound",
      execution_id: start.execution_id,
      provider_turn_id: "fixture_turn_1",
    },
    { event: "progress", execution_id: start.execution_id, text: "fixture progress" },
    {
      event: "approval_required",
      execution_id: start.execution_id,
      approval_request_id: "fixture_approval_1",
    },
    {
      event: "approval_resolved",
      execution_id: start.execution_id,
      approval_request_id: "fixture_approval_1",
      decision: "denied",
    },
    { event: "reply", execution_id: start.execution_id, text: "fixture reply" },
  ]);
  assert.equal(provider.pulls.filter((id) => id === start.execution_id).length, 6);
  assert.equal(provider.activeExecutionCount, 0);

  const recover: ProviderRecoverRequest = {
    kind: "recover",
    execution_id: "00000000-0000-4000-8000-000000000002",
    conversation_id: start.conversation_id,
    message_id: start.message_id,
    provider_session_id: "fixture_session_1",
    provider_turn_id: "fixture_turn_1",
    deadline_unix_ms: start.deadline_unix_ms,
  };
  assert.deepEqual(
    await collect(provider.invoke(recover, [{ kind: "reply", text: "recovered" }])),
    [{ event: "reply", execution_id: recover.execution_id, text: "recovered" }],
  );

  const noReply = startRequest("00000000-0000-4000-8000-000000000003");
  assert.deepEqual(await collect(provider.invoke(noReply, [{ kind: "no_reply" }])), [
    { event: "completed_without_reply", execution_id: noReply.execution_id },
  ]);
  const malformed = startRequest("00000000-0000-4000-8000-000000000004");
  assert.deepEqual(
    await collect(
      provider.invoke(malformed, [
        { kind: "malformed", value: { event: "unexpected", sender_value: "ignored" } },
      ]),
    ),
    [{ event: "unexpected", sender_value: "ignored" }],
  );
  const oversized = startRequest("00000000-0000-4000-8000-000000000005");
  const oversizedEvents = await collect(
    provider.invoke(oversized, [{ kind: "oversized", event: "reply", text_bytes: 262_145 }]),
  );
  assert.equal(Buffer.byteLength((oversizedEvents[0] as { text: string }).text, "utf8"), 262_145);
  const closed = startRequest("00000000-0000-4000-8000-000000000006");
  assert.deepEqual(await collect(provider.invoke(closed, [{ kind: "close" }])), []);

  assert.equal(provider.spawnRecord.shell, false);
  assert.deepEqual(provider.spawnRecord.environment, expectedEnvironment());
  assert.ok(!provider.spawnRecord.arguments.join("\0").includes(start.input_text));
  assert.ok(!Object.keys(provider.spawnRecord.environment).join("\0").includes(start.input_text));
  assert.ok(!Object.values(provider.spawnRecord.environment).join("\0").includes(start.input_text));
  assert.equal(provider.stderrByteCount, 0);
  await provider.close();
  assert.equal(provider.closed, true);
});

test("the provider fixture supports two executions and records every cancellation field", async (t) => {
  const provider = startScriptedFakeProvider(t);
  const first = startRequest("00000000-0000-4000-8000-000000000007");
  const second = startRequest("00000000-0000-4000-8000-000000000008");
  const firstInvocation = provider.invoke(first, [
    { kind: "progress", text: "first" },
    { kind: "reply", text: "first reply" },
  ]);
  const secondInvocation = provider.invoke(second, [{ kind: "wait_for_cancel" }]);
  assert.equal(provider.activeExecutionCount, 2);
  assert.throws(() =>
    provider.invoke(startRequest("00000000-0000-4000-8000-000000000009"), [{ kind: "no_reply" }]),
  );

  assert.deepEqual(await firstInvocation.next(), {
    done: false,
    value: { event: "progress", execution_id: first.execution_id, text: "first" },
  });
  const safeWaitPull = secondInvocation.next();
  const safeCancel: ProviderCancelRequest = {
    kind: "cancel",
    execution_id: second.execution_id,
    provider_session_id: "fixture_session_2",
    provider_turn_id: "fixture_turn_2",
    reason: "shutdown",
  };
  assert.deepEqual(await provider.cancel(safeCancel), { status: "cancel_requested" });
  assert.deepEqual(await safeWaitPull, {
    done: false,
    value: {
      event: "cancelled",
      execution_id: second.execution_id,
      reason_code: "cancelled_during_safe_wait",
    },
  });
  assert.deepEqual(await secondInvocation.next(), { done: true, value: undefined });

  assert.deepEqual(await firstInvocation.next(), {
    done: false,
    value: { event: "reply", execution_id: first.execution_id, text: "first reply" },
  });
  const terminalCancel: ProviderCancelRequest = {
    kind: "cancel",
    execution_id: first.execution_id,
    provider_session_id: "fixture_session_1",
    provider_turn_id: "fixture_turn_1",
    reason: "deadline",
  };
  assert.deepEqual(await provider.cancel(terminalCancel), { status: "already_terminal" });
  assert.deepEqual(await firstInvocation.next(), { done: true, value: undefined });

  const missingCancel: ProviderCancelRequest = {
    kind: "cancel",
    execution_id: "00000000-0000-4000-8000-000000000099",
    provider_session_id: null,
    provider_turn_id: null,
    reason: "contract_failure",
  };
  assert.deepEqual(await provider.cancel(missingCancel), { status: "not_found" });
  assert.deepEqual(provider.cancellations, [safeCancel, terminalCancel, missingCancel]);
  assert.equal(provider.activeExecutionCount, 0);
  await provider.close();
});

test("the provider fixture makes a scripted crash observable without transcript output", async (t) => {
  const provider = startScriptedFakeProvider(t);
  const request = startRequest(
    "00000000-0000-4000-8000-000000000010",
    "content that must not be logged",
  );
  const invocation = provider.invoke(request, [{ kind: "crash", exit_code: 23 }]);
  await assert.rejects(
    invocation.next(),
    (error: unknown) => error instanceof FakeProviderExitedError && error.exitCode === 23,
  );
  await provider.close();
  assert.equal(provider.closed, true);
  assert.equal(provider.stderrByteCount, 0);
});
