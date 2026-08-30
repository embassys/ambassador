import assert from "node:assert/strict";
import test from "node:test";
import { type K04IpcBoundary, parseK04IpcEnvelope } from "./support/connector/k04-ipc.js";
import {
  enrollK04Gateway,
  K04_CONTENT_PREFIX,
  K04_REPLY_TEXT,
  K04_WEBHOOK_TOKEN,
  receiveK04SenderBatch,
  receiveK04SenderMessage,
  replyToK04SenderMessage,
  scanK04Artifacts,
  sendK04Wake,
  startK04ConnectorProcess,
  startK04Fixture,
  startK04GatewayProcess,
  startK04InboundConversation,
  stopK04ConnectorProcess,
  waitForK04Acknowledgement,
} from "./support/connector/k04-process-harness.js";

test("K04 rejects primitive and content-bearing foreign IPC envelopes", () => {
  const boundaries: readonly K04IpcBoundary[] = [
    "connector_parent",
    "gateway_parent",
    "connector_child",
    "gateway_child",
  ];
  for (const boundary of boundaries) {
    assert.throws(
      () => parseK04IpcEnvelope(boundary, `${K04_CONTENT_PREFIX}foreign-ipc-payload`),
      /unexpected K04 IPC envelope or channel/u,
    );
    assert.throws(
      () =>
        parseK04IpcEnvelope(boundary, {
          channel: "foreign",
          payload: `${K04_CONTENT_PREFIX}foreign-ipc-payload`,
        }),
      /unexpected K04 IPC envelope or channel/u,
    );
  }
  for (const boundary of ["connector_parent", "gateway_parent"] as const) {
    assert.deepEqual(
      parseK04IpcEnvelope(boundary, {
        kind: "a2a-t02-barrier-arrival",
        name: "commit",
        sequence: 1,
      }),
      { kind: "shared" },
    );
  }
  for (const boundary of ["connector_child", "gateway_child"] as const) {
    assert.deepEqual(
      parseK04IpcEnvelope(boundary, {
        kind: "a2a-t02-barrier-release",
        name: "commit",
        sequence: 1,
      }),
      { kind: "shared" },
    );
  }
});

test("K04-E01 runs one message through the normal gateway and connector processes", async (t) => {
  const fixture = await startK04Fixture(t);
  const connector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  const gateway = await startK04GatewayProcess(t, fixture, connector.webhookUrl);
  const client = await enrollK04Gateway(fixture, gateway.endpoint);

  const inbound = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000044001",
  );
  await waitForK04Acknowledgement(fixture, inbound.messageId);

  const reply = await receiveK04SenderMessage(fixture, inbound.messageId);
  assert.equal(reply.conversation_id, inbound.conversationId);
  assert.equal(reply.in_reply_to_message_id, inbound.messageId);
  assert.deepEqual(reply.payload, { text: K04_REPLY_TEXT });
  assert.deepEqual(fixture.central.v2MessageState(inbound.messageId), {
    id: inbound.messageId,
    conversationId: inbound.conversationId,
    recipientAgentId: "agent_fixture_0001",
    terminalOutcome: "replied",
    replyMessageId: reply.id,
    acknowledged: true,
    leaseUntil: null,
  });

  const requests = connector.control.providerRequests();
  assert.deepEqual(requests, [
    {
      kind: "start",
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      providerSessionId: `k04_session_${inbound.conversationId}`,
      providerTurnId: null,
    },
  ]);

  const tools = await client.listTools();
  for (const name of [
    "poll_messages",
    "reply_message",
    "complete_message",
    "get_message_outcome",
    "ack_message",
  ]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `gateway did not expose ${name}`);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /token|credential|proof/iu);
  }

  const connectorExit = await stopK04ConnectorProcess(connector);
  assert.deepEqual(connectorExit, { code: 0, signal: null }, connector.process.stderr());
  assert.deepEqual(await gateway.process.stop(), { code: 0, signal: null });
  await scanK04Artifacts({
    fixture,
    captures: [
      { name: "connector-stdout", value: connector.process.stdout() },
      { name: "connector-stderr", value: connector.process.stderr() },
      { name: "gateway-stdout", value: gateway.process.stdout() },
      { name: "gateway-stderr", value: gateway.process.stderr() },
    ],
    markers: [
      { name: "webhook-token", value: K04_WEBHOOK_TOKEN },
      { name: "inbound-text", value: fixture.inboundText },
      { name: "reply-text", value: K04_REPLY_TEXT },
    ],
  });
});

test("K04-R01 resumes the same provider session for a second turn after restart", async (t) => {
  const fixture = await startK04Fixture(t);
  const firstConnector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  const gateway = await startK04GatewayProcess(t, fixture, firstConnector.webhookUrl);
  await enrollK04Gateway(fixture, gateway.endpoint);

  const firstInbound = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000044002",
  );
  await waitForK04Acknowledgement(fixture, firstInbound.messageId);
  const firstReply = await receiveK04SenderMessage(fixture, firstInbound.messageId);
  assert.deepEqual(
    await stopK04ConnectorProcess(firstConnector),
    { code: 0, signal: null },
    firstConnector.process.stderr(),
  );

  const secondConnector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  const secondInboundText = `${K04_CONTENT_PREFIX}second-inbound-turn-c07291.`;
  const secondInbound = await replyToK04SenderMessage(
    fixture,
    firstReply.id as string,
    secondInboundText,
  );
  assert.equal(secondInbound.conversationId, firstInbound.conversationId);
  await waitForK04Acknowledgement(fixture, secondInbound.messageId);
  const secondReply = await receiveK04SenderMessage(fixture, secondInbound.messageId);
  assert.equal(secondReply.conversation_id, firstInbound.conversationId);

  assert.deepEqual(firstConnector.control.providerRequests(), [
    {
      kind: "start",
      conversationId: firstInbound.conversationId,
      messageId: firstInbound.messageId,
      providerSessionId: `k04_session_${firstInbound.conversationId}`,
      providerTurnId: null,
    },
  ]);
  assert.deepEqual(secondConnector.control.providerRequests(), [
    {
      kind: "resume",
      conversationId: secondInbound.conversationId,
      messageId: secondInbound.messageId,
      providerSessionId: `k04_session_${firstInbound.conversationId}`,
      providerTurnId: null,
    },
  ]);
  assert.deepEqual(
    await stopK04ConnectorProcess(secondConnector),
    { code: 0, signal: null },
    secondConnector.process.stderr(),
  );
  assert.deepEqual(await gateway.process.stop(), { code: 0, signal: null });
  await scanK04Artifacts({
    fixture,
    captures: [
      {
        name: "connector-stdout",
        value: `${firstConnector.process.stdout()}${secondConnector.process.stdout()}`,
      },
      {
        name: "connector-stderr",
        value: `${firstConnector.process.stderr()}${secondConnector.process.stderr()}`,
      },
      { name: "gateway-stdout", value: gateway.process.stdout() },
      { name: "gateway-stderr", value: gateway.process.stderr() },
    ],
    markers: [
      { name: "first-inbound", value: fixture.inboundText },
      { name: "second-inbound", value: secondInboundText },
      { name: "reply", value: K04_REPLY_TEXT },
      { name: "token", value: K04_WEBHOOK_TOKEN },
    ],
  });
});

test("K04-E02/E03 bounds concurrent conversations and coalesces duplicate wakes", async (t) => {
  const fixture = await startK04Fixture(t);
  const connector = await startK04ConnectorProcess(t, fixture, {
    plan: "reply",
    providerGate: "reply",
  });
  const gateway = await startK04GatewayProcess(t, fixture, connector.webhookUrl);
  await enrollK04Gateway(fixture, gateway.endpoint);

  const inbound = await Promise.all(
    [44_003, 44_004, 44_005].map(
      async (suffix) =>
        await startK04InboundConversation(
          fixture,
          `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
          `${fixture.inboundText} ${suffix}`,
        ),
    ),
  );
  await connector.control.waitForProviderRequests(2);
  await connector.control.waitForProviderBarriers(2);
  assert.equal(connector.control.providerRequests().length, 2);

  const timestamp = Math.floor(Date.now() / 1_000);
  assert.equal(
    (await sendK04Wake(connector, inbound[0]?.messageId as string, timestamp + 1)).status,
    202,
  );
  assert.equal(
    (await sendK04Wake(connector, inbound[0]?.messageId as string, timestamp + 2)).status,
    202,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connector.control.providerRequests().length, 2);

  connector.control.releaseProviderBarrier();
  connector.control.releaseProviderBarrier();
  await connector.control.waitForProviderRequests(3);
  await connector.control.waitForProviderBarriers(3);
  connector.control.releaseProviderBarrier();
  await Promise.all(
    inbound.map(async (message) => await waitForK04Acknowledgement(fixture, message.messageId)),
  );

  const requests = connector.control.providerRequests();
  assert.equal(requests.length, 3);
  assert.deepEqual(
    [...requests].sort((a, b) => a.messageId.localeCompare(b.messageId)),
    inbound
      .map((message) => ({
        kind: "start" as const,
        conversationId: message.conversationId,
        messageId: message.messageId,
        providerSessionId: `k04_session_${message.conversationId}`,
        providerTurnId: null,
      }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId)),
  );
  const replies = await receiveK04SenderBatch(fixture);
  assert.equal(replies.length, 3);
  assert.ok(
    replies.every((reply) => (reply.payload as Record<string, unknown>).text === K04_REPLY_TEXT),
  );

  assert.deepEqual(
    await stopK04ConnectorProcess(connector),
    { code: 0, signal: null },
    connector.process.stderr(),
  );
  assert.deepEqual(await gateway.process.stop(), { code: 0, signal: null });
  await scanK04Artifacts({
    fixture,
    captures: [
      { name: "connector-stdout", value: connector.process.stdout() },
      { name: "connector-stderr", value: connector.process.stderr() },
      { name: "gateway-stdout", value: gateway.process.stdout() },
      { name: "gateway-stderr", value: gateway.process.stderr() },
    ],
    markers: [
      ...[44_003, 44_004, 44_005].map((suffix, index) => ({
        name: `inbound-${index + 1}`,
        value: `${fixture.inboundText} ${suffix}`,
      })),
      { name: "reply", value: K04_REPLY_TEXT },
    ],
  });
});
