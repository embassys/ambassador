import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  assertK04MessageRows,
  enrollK04Gateway,
  K04_CONTENT_PREFIX,
  K04_REPLY_TEXT,
  type K04ConnectorCrashBarrier,
  type K04ConnectorProcess,
  type K04GatewayFetchBarrier,
  type K04GatewayOperation,
  type K04GatewayProcess,
  receiveK04SenderBatch,
  scanK04Artifacts,
  startK04ConnectorProcess,
  startK04Fixture,
  startK04GatewayProcess,
  startK04InboundConversation,
  stopK04ConnectorProcess,
  waitForK04Acknowledgement,
} from "./support/connector/k04-process-harness.js";
import type { V2ManagedProcess } from "./support/v2-process-runtime.js";

interface CrashCaptures {
  readonly connectors: readonly K04ConnectorProcess[];
  readonly gateways: readonly K04GatewayProcess[];
}

function countOperations(
  gateways: readonly K04GatewayProcess[],
  operation: K04GatewayOperation,
): number {
  return gateways.reduce(
    (count, gateway) =>
      count + gateway.control.operations().filter((candidate) => candidate === operation).length,
    0,
  );
}

function assertOperationCounts(
  gateways: readonly K04GatewayProcess[],
  expected: Partial<Record<K04GatewayOperation, number>>,
): void {
  for (const [operation, count] of Object.entries(expected)) {
    assert.equal(
      countOperations(gateways, operation as K04GatewayOperation),
      count,
      `${operation} request count`,
    );
  }
}

async function waitForOperationCounts(
  gateways: readonly K04GatewayProcess[],
  expected: Partial<Record<K04GatewayOperation, number>>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      Object.entries(expected).every(
        ([operation, count]) =>
          countOperations(gateways, operation as K04GatewayOperation) >= (count ?? 0),
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("K04 gateway operations did not reach their expected counts");
}

function sendHardKill(process: V2ManagedProcess): void {
  assert.equal(process.child.kill("SIGKILL"), true, "failed to send SIGKILL to process");
}

async function drainHardKill(process: V2ManagedProcess): Promise<void> {
  const exit = await process.waitForExit();
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
  await process.stop();
}

async function hardKill(process: V2ManagedProcess): Promise<void> {
  sendHardKill(process);
  await drainHardKill(process);
}

async function stopProcesses(
  fixture: Awaited<ReturnType<typeof startK04Fixture>>,
  captures: CrashCaptures,
): Promise<void> {
  const lastConnector = captures.connectors.at(-1);
  const lastGateway = captures.gateways.at(-1);
  if (lastConnector !== undefined) {
    assert.deepEqual(
      await stopK04ConnectorProcess(lastConnector),
      { code: 0, signal: null },
      lastConnector.process.stderr(),
    );
  }
  if (lastGateway !== undefined) {
    assert.deepEqual(await lastGateway.process.stop(), { code: 0, signal: null });
  }
  assertK04MessageRows(fixture, 0);
}

async function scanCrashArtifacts(
  fixture: Awaited<ReturnType<typeof startK04Fixture>>,
  captures: CrashCaptures,
  inboundText: string,
): Promise<void> {
  await scanK04Artifacts({
    fixture,
    captures: [
      {
        name: "connector-stdout",
        value: captures.connectors.map((connector) => connector.process.stdout()).join(""),
      },
      {
        name: "connector-stderr",
        value: captures.connectors.map((connector) => connector.process.stderr()).join(""),
      },
      {
        name: "gateway-stdout",
        value: captures.gateways.map((gateway) => gateway.process.stdout()).join(""),
      },
      {
        name: "gateway-stderr",
        value: captures.gateways.map((gateway) => gateway.process.stderr()).join(""),
      },
    ],
    markers: [
      { name: "inbound-text", value: inboundText },
      { name: "reply-text", value: K04_REPLY_TEXT },
    ],
  });
}

function expectedStartRequest(inbound: {
  readonly messageId: string;
  readonly conversationId: string;
}) {
  return {
    kind: "start" as const,
    conversationId: inbound.conversationId,
    messageId: inbound.messageId,
    providerSessionId: `k04_session_${inbound.conversationId}`,
    providerTurnId: null,
  };
}

function expectedRecoverRequest(inbound: {
  readonly messageId: string;
  readonly conversationId: string;
}) {
  return {
    kind: "recover" as const,
    conversationId: inbound.conversationId,
    messageId: inbound.messageId,
    providerSessionId: `k04_session_${inbound.conversationId}`,
    providerTurnId: `k04_turn_${inbound.messageId}`,
  };
}

async function assertOneReply(
  fixture: Awaited<ReturnType<typeof startK04Fixture>>,
  inbound: { readonly messageId: string; readonly conversationId: string },
): Promise<void> {
  const replies = await receiveK04SenderBatch(fixture);
  assert.equal(replies.length, 1);
  const reply = replies[0];
  assert.equal(reply?.conversation_id, inbound.conversationId);
  assert.equal(reply?.in_reply_to_message_id, inbound.messageId);
  assert.deepEqual(reply?.payload, { text: K04_REPLY_TEXT });
  assert.deepEqual(fixture.central.v2MessageState(inbound.messageId), {
    id: inbound.messageId,
    conversationId: inbound.conversationId,
    recipientAgentId: "agent_fixture_0001",
    terminalOutcome: "replied",
    replyMessageId: reply?.id,
    acknowledged: true,
    leaseUntil: null,
  });
}

async function runGatewayCustodyCrash(
  t: TestContext,
  options: {
    readonly barrier: Extract<K04GatewayFetchBarrier, "receive_selected" | "wake_before_request">;
    readonly requestId: string;
    readonly inboundText: string;
  },
): Promise<void> {
  const fixture = await startK04Fixture(t);
  const connector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  const firstGateway = await startK04GatewayProcess(t, fixture, connector.webhookUrl, {
    fetchBarrier: options.barrier,
  });
  await enrollK04Gateway(fixture, firstGateway.endpoint);
  const inbound = await startK04InboundConversation(
    fixture,
    options.requestId,
    options.inboundText,
  );

  await firstGateway.control.waitForFetchBarrier(options.barrier);
  assert.equal(connector.control.providerRequests().length, 0);
  await hardKill(firstGateway.process);
  fixture.central.advanceClock(60);

  const secondGateway = await startK04GatewayProcess(t, fixture, connector.webhookUrl, {
    observeFetch: true,
  });
  await waitForK04Acknowledgement(fixture, inbound.messageId);
  await connector.control.waitForIdle();
  await waitForOperationCounts([firstGateway, secondGateway], {
    reply: 1,
    complete: 0,
    outcome: 0,
    ack: 1,
  });
  assert.deepEqual(connector.control.providerRequests(), [expectedStartRequest(inbound)]);
  await assertOneReply(fixture, inbound);
  assertOperationCounts([firstGateway, secondGateway], {
    reply: 1,
    complete: 0,
    outcome: 0,
    ack: 1,
  });

  const captures = { connectors: [connector], gateways: [firstGateway, secondGateway] };
  await stopProcesses(fixture, captures);
  await scanCrashArtifacts(fixture, captures, options.inboundText);
}

async function runConnectorCrash(
  t: TestContext,
  options: {
    readonly barrier: K04ConnectorCrashBarrier;
    readonly requestId: string;
    readonly inboundText: string;
    readonly expectedFirst: "none" | "start";
    readonly expectedRecovery: "none" | "recover";
    readonly expectedOperations: Partial<Record<K04GatewayOperation, number>>;
    readonly proveNoProviderDispatch?: boolean;
    readonly expectReply: boolean;
    readonly expectedCommittedOutcome: null | "replied";
  },
): Promise<void> {
  const fixture = await startK04Fixture(t);
  const firstConnector = await startK04ConnectorProcess(t, fixture, {
    plan: "reply",
    crashBarrier: options.barrier,
  });
  const gateway = await startK04GatewayProcess(t, fixture, firstConnector.webhookUrl, {
    observeFetch: true,
  });
  await enrollK04Gateway(fixture, gateway.endpoint);
  const inbound = await startK04InboundConversation(
    fixture,
    options.requestId,
    options.inboundText,
  );

  await firstConnector.control.waitForCrashBarrier(options.barrier);
  assert.deepEqual(
    firstConnector.control.providerRequests(),
    options.expectedFirst === "start" ? [expectedStartRequest(inbound)] : [],
  );
  const beforeCrash = fixture.central.v2MessageState(inbound.messageId);
  assert.equal(beforeCrash.terminalOutcome, options.expectedCommittedOutcome);
  assert.equal(beforeCrash.acknowledged, false);
  await hardKill(firstConnector.process);
  const secondConnector = await startK04ConnectorProcess(t, fixture, {
    plan: "reply",
    ...(options.proveNoProviderDispatch === true ? { proveNoProviderDispatch: true } : {}),
  });
  try {
    await waitForK04Acknowledgement(fixture, inbound.messageId);
  } catch (error) {
    throw new Error(
      `K04 recovery did not acknowledge; complete=${countOperations([gateway], "complete")} ack=${countOperations([gateway], "ack")} connector_exited=${secondConnector.process.child.exitCode !== null || secondConnector.process.child.signalCode !== null} fatal=${secondConnector.control.fatalCode() ?? "none"}`,
      { cause: error },
    );
  }
  await secondConnector.control.waitForIdle();
  await waitForOperationCounts([gateway], options.expectedOperations);
  assert.deepEqual(
    secondConnector.control.providerRequests(),
    options.expectedRecovery === "recover" ? [expectedRecoverRequest(inbound)] : [],
  );
  assertOperationCounts([gateway], options.expectedOperations);

  if (options.expectReply) {
    await assertOneReply(fixture, inbound);
  } else {
    assert.deepEqual(await receiveK04SenderBatch(fixture), []);
    assert.deepEqual(fixture.central.v2MessageState(inbound.messageId), {
      id: inbound.messageId,
      conversationId: inbound.conversationId,
      recipientAgentId: "agent_fixture_0001",
      terminalOutcome: "failed",
      replyMessageId: null,
      acknowledged: true,
      leaseUntil: null,
    });
    assert.deepEqual(gateway.control.completionRequests(), [
      { outcome: "failed", reasonCode: "provider_start_failed" },
    ]);
  }

  const captures = {
    connectors: [firstConnector, secondConnector],
    gateways: [gateway],
  };
  await stopProcesses(fixture, captures);
  await scanCrashArtifacts(fixture, captures, options.inboundText);
}

async function runAcceptedResponseLostCrash(
  t: TestContext,
  options: {
    readonly barrier: Extract<
      K04GatewayFetchBarrier,
      "reply_accepted_unobserved" | "ack_accepted_unobserved"
    >;
    readonly requestId: string;
    readonly inboundText: string;
    readonly expectedOperations: Partial<Record<K04GatewayOperation, number>>;
  },
): Promise<void> {
  const fixture = await startK04Fixture(t);
  const firstConnector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  const firstGateway = await startK04GatewayProcess(t, fixture, firstConnector.webhookUrl, {
    fetchBarrier: options.barrier,
  });
  await enrollK04Gateway(fixture, firstGateway.endpoint);
  const inbound = await startK04InboundConversation(
    fixture,
    options.requestId,
    options.inboundText,
  );

  await firstGateway.control.waitForFetchBarrier(options.barrier);
  const committed = fixture.central.v2MessageState(inbound.messageId);
  assert.equal(committed.terminalOutcome, "replied");
  assert.equal(committed.acknowledged, options.barrier === "ack_accepted_unobserved");
  assert.deepEqual(firstConnector.control.providerRequests(), [expectedStartRequest(inbound)]);

  sendHardKill(firstGateway.process);
  sendHardKill(firstConnector.process);
  await Promise.all([drainHardKill(firstGateway.process), drainHardKill(firstConnector.process)]);

  const secondGateway = await startK04GatewayProcess(t, fixture, firstConnector.webhookUrl, {
    observeFetch: true,
  });
  const secondConnector = await startK04ConnectorProcess(t, fixture, { plan: "reply" });
  await waitForOperationCounts([firstGateway, secondGateway], options.expectedOperations);
  await waitForK04Acknowledgement(fixture, inbound.messageId);
  await secondConnector.control.waitForIdle();
  assert.equal(secondConnector.control.providerRequests().length, 0);
  await assertOneReply(fixture, inbound);
  assertOperationCounts([firstGateway, secondGateway], options.expectedOperations);

  const captures = {
    connectors: [firstConnector, secondConnector],
    gateways: [firstGateway, secondGateway],
  };
  await stopProcesses(fixture, captures);
  await scanCrashArtifacts(fixture, captures, options.inboundText);
}

test("K04-C01.1 redelivers after central selected a message before returning it", async (t) => {
  await runGatewayCustodyCrash(t, {
    barrier: "receive_selected",
    requestId: "00000000-0000-4000-8000-000000044101",
    inboundText: `${K04_CONTENT_PREFIX}receive-selection-crash-140d31.`,
  });
});

test("K04-C01.2 redelivers after gateway received a message before sending its wake", async (t) => {
  await runGatewayCustodyCrash(t, {
    barrier: "wake_before_request",
    requestId: "00000000-0000-4000-8000-000000044102",
    inboundText: `${K04_CONTENT_PREFIX}pre-wake-crash-2a55f0.`,
  });
});

test("K04-C01.3 never dispatches after the binding decision survives a crash", async (t) => {
  await runConnectorCrash(t, {
    barrier: "binding_published",
    requestId: "00000000-0000-4000-8000-000000044103",
    inboundText: `${K04_CONTENT_PREFIX}binding-crash-3b31cc.`,
    expectedFirst: "none",
    expectedRecovery: "none",
    expectedOperations: { reply: 0, complete: 1, outcome: 0, ack: 1 },
    proveNoProviderDispatch: true,
    expectReply: false,
    expectedCommittedOutcome: null,
  });
});

test("K04-C01.4 recovers the exact turn after its provider ID became durable", async (t) => {
  await runConnectorCrash(t, {
    barrier: "turn_published",
    requestId: "00000000-0000-4000-8000-000000044104",
    inboundText: `${K04_CONTENT_PREFIX}durable-turn-crash-4edc12.`,
    expectedFirst: "start",
    expectedRecovery: "recover",
    expectedOperations: { reply: 1, complete: 0, outcome: 0, ack: 1 },
    expectReply: true,
    expectedCommittedOutcome: null,
  });
});

test("K04-C01.5 recovers the exact provider result after terminal output was volatile", async (t) => {
  await runConnectorCrash(t, {
    barrier: "provider_terminal_received",
    requestId: "00000000-0000-4000-8000-000000044105",
    inboundText: `${K04_CONTENT_PREFIX}volatile-terminal-crash-5a26d4.`,
    expectedFirst: "start",
    expectedRecovery: "recover",
    expectedOperations: { reply: 1, complete: 0, outcome: 0, ack: 1 },
    expectReply: true,
    expectedCommittedOutcome: null,
  });
});

test("K04-C01.6 resolves one reply whose accepted response was never observed", async (t) => {
  await runAcceptedResponseLostCrash(t, {
    barrier: "reply_accepted_unobserved",
    requestId: "00000000-0000-4000-8000-000000044106",
    inboundText: `${K04_CONTENT_PREFIX}lost-reply-response-6d7fc0.`,
    expectedOperations: { reply: 1, complete: 0, outcome: 1, ack: 1 },
  });
});

test("K04-C01.7 repeats only acknowledgement after the durable reply transition", async (t) => {
  await runConnectorCrash(t, {
    barrier: "reply_accepted",
    requestId: "00000000-0000-4000-8000-000000044107",
    inboundText: `${K04_CONTENT_PREFIX}post-reply-crash-7f42aa.`,
    expectedFirst: "start",
    expectedRecovery: "none",
    expectedOperations: { reply: 1, complete: 0, outcome: 0, ack: 1 },
    expectReply: true,
    expectedCommittedOutcome: "replied",
  });
});

test("K04-C01.8 repeats only acknowledgement after its accepted response was lost", async (t) => {
  await runAcceptedResponseLostCrash(t, {
    barrier: "ack_accepted_unobserved",
    requestId: "00000000-0000-4000-8000-000000044108",
    inboundText: `${K04_CONTENT_PREFIX}lost-ack-response-8c119e.`,
    expectedOperations: { reply: 1, complete: 0, outcome: 0, ack: 2 },
  });
});
