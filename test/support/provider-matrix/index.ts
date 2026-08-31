import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import { startConnectorRuntime } from "../../../packages/connector-core/src/connector.js";
import type { ProviderPort } from "../../../packages/connector-core/src/runtime-types.js";
import {
  type FakeCodexAppServer,
  type FakeCodexProcessPlan,
  handshakeExchanges,
  loadCx03Production,
  startFakeCodexAppServer,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "../codex-app-server/index.js";
import {
  enrollK04Gateway,
  K04_WEBHOOK_TOKEN,
  type K04Fixture,
  receiveK04SenderMessage,
  replyToK04SenderMessage,
  scanK04Artifacts,
  startK04Fixture,
  startK04GatewayProcess,
  startK04InboundConversation,
  waitForK04Acknowledgement,
} from "../connector/k04-process-harness.js";
import {
  startV2ManagedProcess,
  type V2ManagedProcess,
  v2NodeProcessEnvironment,
} from "../v2-process-runtime.js";

const CONTENT_PREFIX = "Q01-sensitive-content-";
const FIRST_INPUT = `${CONTENT_PREFIX}first-input-a381.`;
const PARALLEL_INPUT = `${CONTENT_PREFIX}parallel-input-b492.`;
const CONTINUATION_INPUT = `${CONTENT_PREFIX}continuation-input-c503.`;
const FIRST_REPLY = `${CONTENT_PREFIX}first-reply-d614.`;
const PARALLEL_REPLY = `${CONTENT_PREFIX}parallel-reply-e725.`;
const CONTINUATION_REPLY = `${CONTENT_PREFIX}continuation-reply-f836.`;
const FIRST_THREAD = "019c0000-0000-7000-8000-000000000101";
const FIRST_TURN = "019c0000-0000-7000-8000-000000000102";
const PARALLEL_THREAD = "019c0000-0000-7000-8000-000000000111";
const PARALLEL_TURN = "019c0000-0000-7000-8000-000000000112";
const CONTINUATION_TURN = "019c0000-0000-7000-8000-000000000103";

interface Q01Scenario {
  readonly firstInput: string;
  readonly parallelInput: string;
  readonly continuationInput: string;
  readonly firstReply: string;
  readonly parallelReply: string;
  readonly continuationReply: string;
}

interface Q01ProviderRuntime {
  readonly process: V2ManagedProcess;
  readonly webhookUrl: string;
  waitForCompleteUnits(count: number): Promise<void>;
  assertProtocol(): void;
  stop(): Promise<void>;
}

export interface Q01ProviderRow {
  readonly key: "codex" | "claude";
  readonly name: string;
  start(t: TestContext, fixture: K04Fixture, scenario: Q01Scenario): Promise<Q01ProviderRuntime>;
}

function threadStarted(cwd: string, threadId: string): unknown {
  return { method: "thread/started", params: { thread: validThread(cwd, threadId) } };
}

function turnStarted(threadId: string, turnId: string): unknown {
  return { method: "turn/started", params: { threadId, turn: validTurn(turnId) } };
}

function turnCompleted(text: string, threadId: string, turnId: string): unknown {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: validTurn(turnId, "completed", [
        { id: `item_${turnId}`, type: "agentMessage", phase: "final_answer", text },
      ]),
    },
  };
}

function threadStartRequest(cwd: string): Readonly<Record<string, unknown>> {
  return {
    id: 2,
    method: "thread/start",
    params: {
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "a2a_codex_connector",
    },
  };
}

function threadResumeRequest(cwd: string): Readonly<Record<string, unknown>> {
  return {
    id: 2,
    method: "thread/resume",
    params: {
      threadId: FIRST_THREAD,
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    },
  };
}

function turnStartRequest(
  cwd: string,
  threadId: string,
  text: string,
): Readonly<Record<string, unknown>> {
  return {
    id: 3,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  };
}

function startPlan(
  cwd: string,
  threadId: string,
  turnId: string,
  input: string,
  reply: string,
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  return {
    kind: "app-server",
    spawnDescendant: true,
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/start",
        expectRequest: threadStartRequest(cwd),
        result: threadSettingsResponse(cwd, threadId),
        afterResponse: [{ kind: "json", value: threadStarted(cwd, threadId) }],
      },
      {
        expectMethod: "turn/start",
        expectRequest: turnStartRequest(cwd, threadId, input),
        result: { turn: validTurn(turnId) },
        afterResponse: [
          { kind: "json", value: turnStarted(threadId, turnId) },
          { kind: "json", value: turnCompleted(reply, threadId, turnId) },
        ],
      },
    ],
  };
}

function resumePlan(cwd: string): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  return {
    kind: "app-server",
    spawnDescendant: true,
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/resume",
        expectRequest: threadResumeRequest(cwd),
        result: threadSettingsResponse(cwd, FIRST_THREAD),
      },
      {
        expectMethod: "turn/start",
        expectRequest: turnStartRequest(cwd, FIRST_THREAD, CONTINUATION_INPUT),
        result: { turn: validTurn(CONTINUATION_TURN) },
        afterResponse: [
          { kind: "json", value: turnStarted(FIRST_THREAD, CONTINUATION_TURN) },
          {
            kind: "json",
            value: turnCompleted(CONTINUATION_REPLY, FIRST_THREAD, CONTINUATION_TURN),
          },
        ],
      },
    ],
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFakeUnitsGone(fake: FakeCodexAppServer, count: number): Promise<void> {
  await Promise.all([fake.waitForStdinClosed(count), fake.waitForDescendants(count)]);
  const appLaunches = fake.launches.filter((launch) => launch.mode === "app-server");
  assert.equal(appLaunches.length, count);
  const deadline = Date.now() + 5_000;
  while (
    appLaunches.some(
      (launch) =>
        processExists(launch.pid) ||
        (launch.descendantPid !== undefined && processExists(launch.descendantPid)),
    )
  ) {
    if (Date.now() >= deadline) throw new Error("Q01 fake provider process unit survived teardown");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function startCodexRow(
  t: TestContext,
  fixture: K04Fixture,
  scenario: Q01Scenario,
): Promise<Q01ProviderRuntime> {
  const providerHome = join(fixture.rootDirectory, "provider-home");
  await mkdir(providerHome, { recursive: true, mode: 0o700 });
  const fake = await startFakeCodexAppServer(t, [
    { kind: "version", stdout: "codex-cli 0.149.0\n" },
    startPlan(
      fixture.workingDirectory,
      FIRST_THREAD,
      FIRST_TURN,
      scenario.firstInput,
      scenario.firstReply,
    ),
    resumePlan(fixture.workingDirectory),
    startPlan(
      fixture.workingDirectory,
      PARALLEL_THREAD,
      PARALLEL_TURN,
      scenario.parallelInput,
      scenario.parallelReply,
    ),
  ]);
  const managed = startV2ManagedProcess(t, {
    command: process.execPath,
    args: [
      `${process.cwd()}/.test-dist/test/support/provider-matrix/index.js`,
      "q01-connector-child",
      String(fixture.webhookPort),
      fixture.workingDirectory,
    ],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      HOME: providerHome,
      LANG: "C.UTF-8",
      PATH: dirname(process.execPath),
      Q01_CODEX_EXECUTABLE: fake.executablePath,
      Q01_CONNECTOR_STATE: fixture.connectorStateDirectory,
      K04_WEBHOOK_TOKEN,
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 2_000,
    forcedStopMs: 3_000,
  });
  const webhookUrl = `http://127.0.0.1:${fixture.webhookPort}/webhook`;
  await managed.waitForOutput("stdout", `Connector webhook: ${webhookUrl}\n`, 10_000);
  assert.equal(managed.stderr(), "");
  return {
    process: managed,
    webhookUrl,
    waitForCompleteUnits: async (count) => await waitForFakeUnitsGone(fake, count),
    assertProtocol: () => {
      const launches = fake.launches;
      assert.equal(launches.filter((launch) => launch.mode === "version").length, 1);
      const apps = launches.filter((launch) => launch.mode === "app-server");
      assert.equal(apps.length, 3);
      assert.deepEqual(
        apps.flatMap((launch) =>
          launch.requests.filter((request) => request.method === "thread/start").map(() => "start"),
        ),
        ["start", "start"],
      );
      const resume = apps.find((launch) =>
        launch.requests.some((request) => request.method === "thread/resume"),
      );
      assert.ok(resume !== undefined);
      assert.deepEqual(
        resume.requests.filter((request) =>
          ["thread/resume", "turn/start"].includes(String(request.method)),
        ),
        [
          threadResumeRequest(fixture.workingDirectory),
          turnStartRequest(fixture.workingDirectory, FIRST_THREAD, scenario.continuationInput),
        ],
      );
      assert.ok(apps.every((launch) => launch.stdinClosed));
      const environment = JSON.stringify(launches.map((launch) => launch.environment));
      for (const marker of [
        scenario.firstInput,
        scenario.parallelInput,
        scenario.continuationInput,
        scenario.firstReply,
        scenario.parallelReply,
        scenario.continuationReply,
        K04_WEBHOOK_TOKEN,
      ]) {
        assert.equal(environment.includes(marker), false);
      }
    },
    stop: async () => {
      assert.deepEqual(await managed.stop(), { code: 0, signal: null }, managed.stderr());
      assert.equal(managed.stderr(), "");
    },
  };
}

export const CODEX_Q01_PROVIDER_ROW: Q01ProviderRow = {
  key: "codex",
  name: "Codex App Server",
  start: startCodexRow,
};

function assertTerminalState(fixture: K04Fixture, messageId: string): void {
  const state = fixture.central.v2MessageState(messageId);
  assert.equal(state.terminalOutcome, "replied");
  assert.equal(state.acknowledged, true);
  assert.ok(typeof state.replyMessageId === "string");
}

export async function runQ01ProviderMatrix(t: TestContext, row: Q01ProviderRow): Promise<void> {
  assert.notEqual(process.platform, "win32", "ADR 0033 defers Windows connector support");
  const scenario: Q01Scenario = {
    firstInput: FIRST_INPUT,
    parallelInput: PARALLEL_INPUT,
    continuationInput: CONTINUATION_INPUT,
    firstReply: FIRST_REPLY,
    parallelReply: PARALLEL_REPLY,
    continuationReply: CONTINUATION_REPLY,
  };
  const fixture = await startK04Fixture(t);
  const provider = await row.start(t, fixture, scenario);
  const gateway = await startK04GatewayProcess(t, fixture, provider.webhookUrl, {
    observeFetch: true,
  });
  await enrollK04Gateway(fixture, gateway.endpoint);

  const first = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000071001",
    scenario.firstInput,
  );
  await waitForK04Acknowledgement(fixture, first.messageId);
  await provider.waitForCompleteUnits(1);
  const firstReply = await receiveK04SenderMessage(fixture, first.messageId);
  assert.deepEqual(firstReply.payload, { text: scenario.firstReply });

  assert.equal(typeof firstReply.id, "string");
  const firstReplyId = firstReply.id as string;
  const continuation = await replyToK04SenderMessage(
    fixture,
    firstReplyId,
    scenario.continuationInput,
  );
  assert.equal(continuation.conversationId, first.conversationId);
  try {
    await waitForK04Acknowledgement(fixture, continuation.messageId);
  } catch (error) {
    provider.assertProtocol();
    throw new Error(
      `Q01 continuation did not finish: state=${JSON.stringify(fixture.central.v2MessageState(continuation.messageId))} connector=${provider.process.stdout()} connector_stderr=${provider.process.stderr()} gateway=${gateway.process.stdout()} gateway_stderr=${gateway.process.stderr()}`,
      { cause: error },
    );
  }
  const continuationReply = await receiveK04SenderMessage(fixture, continuation.messageId);
  assert.deepEqual(continuationReply.payload, { text: scenario.continuationReply });
  await provider.waitForCompleteUnits(2);

  const parallel = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000071002",
    scenario.parallelInput,
  );
  await waitForK04Acknowledgement(fixture, parallel.messageId);
  const parallelReply = await receiveK04SenderMessage(fixture, parallel.messageId);
  assert.deepEqual(parallelReply.payload, { text: scenario.parallelReply });

  await provider.waitForCompleteUnits(3);
  provider.assertProtocol();
  for (const messageId of [first.messageId, parallel.messageId, continuation.messageId]) {
    assertTerminalState(fixture, messageId);
  }
  const terminalOperations = gateway.control
    .operations()
    .filter((operation) => ["reply", "complete", "ack"].includes(operation));
  assert.equal(terminalOperations.filter((operation) => operation === "reply").length, 3);
  assert.equal(terminalOperations.filter((operation) => operation === "complete").length, 0);
  assert.equal(terminalOperations.filter((operation) => operation === "ack").length, 3);
  let unacknowledgedReplies = 0;
  for (const operation of terminalOperations) {
    if (operation === "reply") unacknowledgedReplies += 1;
    else if (operation === "ack") unacknowledgedReplies -= 1;
    assert.ok(unacknowledgedReplies >= 0, "Q01 observed an ack before its terminal reply");
  }
  assert.equal(unacknowledgedReplies, 0);

  await provider.stop();
  assert.deepEqual(await gateway.process.stop(), { code: 0, signal: null });
  await scanK04Artifacts({
    fixture,
    captures: [
      { name: `${row.key}-connector-stdout`, value: provider.process.stdout() },
      { name: `${row.key}-connector-stderr`, value: provider.process.stderr() },
      { name: "q01-gateway-stdout", value: gateway.process.stdout() },
      { name: "q01-gateway-stderr", value: gateway.process.stderr() },
    ],
    markers: [
      { name: "q01-first-input", value: scenario.firstInput },
      { name: "q01-parallel-input", value: scenario.parallelInput },
      { name: "q01-continuation-input", value: scenario.continuationInput },
      { name: "q01-first-reply", value: scenario.firstReply },
      { name: "q01-parallel-reply", value: scenario.parallelReply },
      { name: "q01-continuation-reply", value: scenario.continuationReply },
    ],
  });
}

async function runConnectorChild(): Promise<void> {
  const webhookPortText = process.argv[3];
  const workingDirectory = process.argv[4];
  const stateDirectory = process.env.Q01_CONNECTOR_STATE;
  const executablePath = process.env.Q01_CODEX_EXECUTABLE;
  const webhookToken = process.env.K04_WEBHOOK_TOKEN;
  if (
    webhookPortText === undefined ||
    !/^[1-9][0-9]{3,4}$/u.test(webhookPortText) ||
    workingDirectory === undefined ||
    stateDirectory === undefined ||
    executablePath === undefined ||
    webhookToken === undefined
  ) {
    throw new Error("Q01 connector child configuration is invalid");
  }
  const module = await loadCx03Production("Q01-Codex");
  const provider = await module.createCodexAppServerAdapterForTest({
    workingDirectory,
    policy: "read-only",
    inheritedEnvironment: process.env,
    webhookTokenEnvironmentName: "K04_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: executablePath,
  });
  const connectorProvider: ProviderPort = {
    spawnRecord: provider.spawnRecord,
    get containmentAttempts() {
      return provider.containmentAttempts;
    },
    get postTerminalDeliveries() {
      return provider.postTerminalDeliveries;
    },
    start: (request) => provider.start(request as never),
    resume: (request) => provider.resume(request as never),
    recover: (request) => provider.recover(request as never),
    cancel: async (request) => await provider.cancel(request as never),
    contain: async (executionId) => await provider.contain(executionId),
  };
  const connector = await startConnectorRuntime({
    providerKind: "codex",
    webhookPort: Number(webhookPortText),
    webhookToken,
    workingDirectory,
    policy: "read-only",
    gatewayEndpoint: "http://127.0.0.1:8787/mcp",
    stateDirectory,
    provider: connectorProvider,
  });
  process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);
  const signal = await new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  await connector.shutdown(signal);
  await provider.close();
}

if (process.argv[2] === "q01-connector-child") await runConnectorChild();
