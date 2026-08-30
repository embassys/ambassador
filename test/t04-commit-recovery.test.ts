import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  requireT04Tool,
  scanT04Artifacts,
  startInboundConversation,
  startT04GatewayScenario,
  T04_USERNAME,
  T04_WEBHOOK_TOKEN,
} from "./support/t04-gateway-harness.js";
import { startT04ResponseObserver } from "./support/t04-response-observer.js";
import { V2_PROCESS_BARRIER_NAMES } from "./support/v2-process-barriers.js";
import { startV2ManagedProcess, v2NodeProcessEnvironment } from "./support/v2-process-runtime.js";

type OperationKind = "start" | "receive" | "reply" | "complete" | "ack" | "ack-retry";

function startOperationWorker(
  t: TestContext,
  scenario: Awaited<ReturnType<typeof startT04GatewayScenario>>,
  options: {
    readonly operationKind: OperationKind;
    readonly requestId: string;
    readonly messageId?: string;
    readonly observerEnvironment?: Readonly<Record<string, string>>;
  },
) {
  return startV2ManagedProcess(t, {
    command: process.execPath,
    args: [`${process.cwd()}/.test-dist/test/support/t04-crash-worker.js`],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      T04_ARTIFACT_ROOT: scenario.gateway.artifactRoot,
      T04_CENTRAL_API_URL: scenario.central.apiUrl,
      T04_CENTRAL_MCP_URL: scenario.central.mcpUrl,
      T04_WEBHOOK_URL: scenario.webhook.url,
      T04_WEBHOOK_TOKEN,
      T04_REQUEST_ID: options.requestId,
      T04_OPERATION_KIND: options.operationKind,
      ...(options.messageId === undefined ? {} : { T04_MESSAGE_ID: options.messageId }),
      ...options.observerEnvironment,
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 500,
    forcedStopMs: 2_000,
  });
}

async function releaseThroughOperation(
  worker: ReturnType<typeof startOperationWorker>,
  caseId: string,
): Promise<void> {
  for (const name of ["startup", "readiness", "operation"] as const) {
    try {
      await worker.barriers.waitFor(name, 10_000);
    } catch {
      throw new Error(`[${caseId}] gateway did not reach the ${name} barrier`);
    }
    worker.barriers.release(name);
  }
}

async function finishRecovery(
  worker: ReturnType<typeof startOperationWorker>,
  caseId: string,
): Promise<void> {
  for (const name of V2_PROCESS_BARRIER_NAMES) {
    try {
      await worker.barriers.waitFor(name, 10_000);
    } catch {
      throw new Error(`[${caseId}] recovery did not reach the ${name} barrier`);
    }
    worker.barriers.release(name);
  }
  assert.deepEqual(await worker.waitForExit(), { code: 0, signal: null });
  assert.match(worker.stdout(), /T04_OPERATION_ACCEPTED/u);
  assert.equal(worker.stderr(), "");
}

const CASES = [
  { id: "T04-X-start-commit", kind: "start" as const, method: "POST", suffix: "conversations" },
  { id: "T04-X-receive-commit", kind: "receive" as const, method: "GET", suffix: "receive" },
  { id: "T04-X-reply-commit", kind: "reply" as const, method: "POST", suffix: "reply" },
  { id: "T04-X-complete-commit", kind: "complete" as const, method: "POST", suffix: "complete" },
  { id: "T04-X-ack-commit", kind: "ack" as const, method: "POST", suffix: "ack" },
] as const;

for (const [index, spec] of CASES.entries()) {
  test(`${spec.id} kills the gateway after central commit and recovers once`, async (t) => {
    const scenario = await startT04GatewayScenario(t);
    const requiredTool =
      spec.kind === "start"
        ? (["start_conversation", ["payload", "recipient_username", "request_id"]] as const)
        : spec.kind === "reply"
          ? (["reply_message", ["message_id", "payload"]] as const)
          : spec.kind === "complete" || spec.kind === "ack"
            ? (["complete_message", ["message_id", "outcome", "reason_code"]] as const)
            : (["complete_message", ["message_id", "outcome", "reason_code"]] as const);
    await requireT04Tool(scenario.client, requiredTool[0], requiredTool[1], spec.id);
    if (spec.kind === "ack") {
      await requireT04Tool(scenario.client, "ack_message", ["message_id"], spec.id);
    }
    if (spec.kind === "start") {
      scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
    }
    await scenario.gateway.stop();

    const requestId = `00000000-0000-4000-8000-${(40_200 + index).toString().padStart(12, "0")}`;
    const inbound =
      spec.kind === "start" ? undefined : await startInboundConversation(scenario, requestId);
    const targetPath =
      spec.kind === "start"
        ? "/api/v2/conversations"
        : spec.kind === "receive"
          ? "/api/v2/messages/receive"
          : `/api/v2/messages/${inbound?.messageId}/${spec.suffix}`;
    const observer = await startT04ResponseObserver(t, {
      targetOrigin: scenario.central.apiUrl,
      targetPath,
      targetMethod: spec.method,
    });
    const worker = startOperationWorker(t, scenario, {
      operationKind: spec.kind,
      requestId,
      ...(inbound === undefined ? {} : { messageId: inbound.messageId }),
      observerEnvironment: observer.environment,
    });
    await releaseThroughOperation(worker, spec.id);
    const committed = await observer.waitForCommit();
    assert.equal(committed.pathname, targetPath);
    assert.ok(committed.status === 200 || committed.status === 201);
    await worker.stop();
    observer.release();

    if (inbound !== undefined) {
      const state = scenario.central.v2MessageState(inbound.messageId);
      if (spec.kind === "reply") assert.equal(state.terminalOutcome, "replied");
      if (spec.kind === "complete") assert.equal(state.terminalOutcome, "failed");
      if (spec.kind === "ack") assert.equal(state.acknowledged, true);
      if (spec.kind !== "ack") scenario.central.advanceClock(60);
    }

    const recoveryKind = spec.kind === "ack" ? "ack-retry" : spec.kind;
    const recovery = startOperationWorker(t, scenario, {
      operationKind: recoveryKind,
      requestId,
      ...(inbound === undefined ? {} : { messageId: inbound.messageId }),
    });
    await finishRecovery(recovery, spec.id);
    await scanT04Artifacts({
      root: scenario.gateway.artifactRoot,
      stdout: `${worker.stdout()}${recovery.stdout()}`,
      stderr: `${worker.stderr()}${recovery.stderr()}`,
      markers: [
        { name: "webhook-token", value: T04_WEBHOOK_TOKEN },
        {
          name: "start-text",
          value: "T04 crash text must remain process-only 7e2d91.",
        },
        {
          name: "message-text",
          value: "T04 inbound text must remain in bounded process memory 19f4a2.",
        },
        { name: "reply-text", value: "T04 crash reply must remain process-only 67ac20." },
      ],
    });
  });
}
