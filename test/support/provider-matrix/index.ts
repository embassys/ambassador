import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import { startConnectorRuntime } from "../../../packages/connector-core/src/connector.js";
import type { ProviderPort } from "../../../packages/connector-core/src/runtime-types.js";
import {
  exactClaudeArguments,
  type FakeClaudeProcessPlan,
  initRecord,
  inputRecord,
  loadCl03Production,
  resultRecord,
  startFakeClaudeCli,
} from "../claude-code/index.js";
import {
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
const CLAUDE_FIRST_SESSION = "00000000-0000-4000-8000-000000071101";
const CLAUDE_PARALLEL_SESSION = "00000000-0000-4000-8000-000000071102";
const CLAUDE_INPUT_IDS = [
  "00000000-0000-4000-8000-000000071111",
  "00000000-0000-4000-8000-000000071112",
  "00000000-0000-4000-8000-000000071113",
] as const;
const TERMINAL_GATES = ["q01-terminal-1", "q01-terminal-2", "q01-terminal-3"] as const;

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
  diagnostics(): unknown;
  prepareTerminalUnit(count: number): Promise<Q01ObservedUnit>;
  assertTerminalUnitGone(count: number, unit: Q01ObservedUnit): void;
  assertProtocol(): void;
  stop(): Promise<void>;
}

interface Q01ObservedUnit {
  readonly processGroupId: number;
  readonly providerPid: number;
  readonly descendantPid: number;
}

export interface Q01ProviderRow {
  readonly key: "codex" | "claude";
  readonly name: string;
  start(t: TestContext, fixture: K04Fixture, scenario: Q01Scenario): Promise<Q01ProviderRuntime>;
}

function fixedAssertion(condition: boolean, message: string): void {
  assert.equal(condition, true, message);
}

async function processGroupId(pid: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "pgid=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
        killSignal: "SIGKILL",
        maxBuffer: 1_024,
        timeout: 2_000,
      },
      (error, stdout, stderr) => {
        if (error !== null || stderr !== "" || !/^\s*[1-9][0-9]*\s*$/u.test(stdout)) {
          reject(new Error("Q01 process-group observation failed"));
          return;
        }
        const value = Number(stdout.trim());
        if (!Number.isSafeInteger(value) || value < 1) {
          reject(new Error("Q01 process-group observation failed"));
          return;
        }
        resolve(value);
      },
    );
  });
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function observeUnit(
  providerPid: number,
  descendantPid: number | undefined,
  expectedLeader: "provider" | "parent",
): Promise<Q01ObservedUnit> {
  fixedAssertion(descendantPid !== undefined, "Q01 provider descendant was not observed");
  const observedDescendantPid = descendantPid as number;
  const [providerGroupId, descendantGroupId] = await Promise.all([
    processGroupId(providerPid),
    processGroupId(observedDescendantPid),
  ]);
  fixedAssertion(
    providerGroupId === descendantGroupId,
    "Q01 provider processes did not share one group",
  );
  fixedAssertion(
    expectedLeader === "provider"
      ? providerGroupId === providerPid
      : providerGroupId !== providerPid && processExists(providerGroupId),
    "Q01 provider process-group leader was invalid",
  );
  return { processGroupId: providerGroupId, providerPid, descendantPid: observedDescendantPid };
}

function assertUnitGone(unit: Q01ObservedUnit): void {
  fixedAssertion(!processExists(unit.providerPid), "Q01 provider root survived terminal reporting");
  fixedAssertion(
    !processExists(unit.descendantPid),
    "Q01 provider descendant survived terminal reporting",
  );
  fixedAssertion(
    !processExists(unit.processGroupId),
    "Q01 provider group leader survived terminal reporting",
  );
  fixedAssertion(
    !processGroupExists(unit.processGroupId),
    "Q01 provider process group survived terminal reporting",
  );
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
  terminalGate: string,
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
          { kind: "json", value: turnCompleted(reply, threadId, turnId), gate: terminalGate },
        ],
      },
    ],
  };
}

function resumePlan(
  cwd: string,
  terminalGate: string,
): Extract<
  FakeCodexProcessPlan,
  {
    kind: "app-server";
  }
> {
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
            gate: terminalGate,
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
      TERMINAL_GATES[0],
    ),
    resumePlan(fixture.workingDirectory, TERMINAL_GATES[1]),
    startPlan(
      fixture.workingDirectory,
      PARALLEL_THREAD,
      PARALLEL_TURN,
      scenario.parallelInput,
      scenario.parallelReply,
      TERMINAL_GATES[2],
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
      Q01_PROVIDER_KIND: "codex",
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
  fixedAssertion(managed.stderr().length === 0, "Q01 Codex connector emitted stderr");
  return {
    process: managed,
    webhookUrl,
    diagnostics: () => ({
      launches: fake.launches.map((launch) => ({
        mode: launch.mode,
        stdinClosed: launch.stdinClosed,
        requestMethods:
          launch.mode === "app-server"
            ? launch.requests.map((request) => request.method)
            : undefined,
        descendant: launch.descendantPid !== undefined,
      })),
    }),
    prepareTerminalUnit: async (count) => {
      const terminalGate = TERMINAL_GATES[count - 1];
      fixedAssertion(terminalGate !== undefined, "Q01 Codex terminal gate was invalid");
      await fake.waitForBarrier(terminalGate as string);
      const launch = fake.launches.filter((candidate) => candidate.mode === "app-server")[
        count - 1
      ];
      fixedAssertion(launch !== undefined, "Q01 Codex launch was not observed");
      const unit = await observeUnit(
        (launch as NonNullable<typeof launch>).pid,
        (launch as NonNullable<typeof launch>).descendantPid,
        "provider",
      );
      fake.release(terminalGate as string);
      return unit;
    },
    assertTerminalUnitGone: (count, unit) => {
      const launches = fake.launches.filter((launch) => launch.mode === "app-server");
      fixedAssertion(launches.length === count, "Q01 Codex launch count was invalid");
      fixedAssertion(
        launches.slice(0, count).every((launch) => launch.stdinClosed),
        "Q01 Codex stdin remained open at terminal reporting",
      );
      assertUnitGone(unit);
    },
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
      fixedAssertion(
        JSON.stringify(
          resume.requests.filter((request) =>
            ["thread/resume", "turn/start"].includes(String(request.method)),
          ),
        ) ===
          JSON.stringify([
            threadResumeRequest(fixture.workingDirectory),
            turnStartRequest(fixture.workingDirectory, FIRST_THREAD, scenario.continuationInput),
          ]),
        "Q01 Codex resume protocol was invalid",
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
      assert.deepEqual(
        await managed.stop(),
        { code: 0, signal: null },
        "Q01 Codex connector did not stop cleanly",
      );
      fixedAssertion(managed.stderr().length === 0, "Q01 Codex connector emitted stderr");
    },
  };
}

export const CODEX_Q01_PROVIDER_ROW: Q01ProviderRow = {
  key: "codex",
  name: "Codex App Server",
  start: startCodexRow,
};

function claudeTurnPlan(
  cwd: string,
  sessionId: string,
  inputId: string,
  input: string,
  reply: string,
  terminalGate: string,
): Extract<FakeClaudeProcessPlan, { kind: "turn" }> {
  return {
    kind: "turn",
    spawnDescendant: true,
    writesBeforeInput: [{ kind: "json", value: initRecord(cwd, { sessionId }) }],
    writesAfterInput: [
      { kind: "json", value: inputRecord(input, sessionId, inputId) },
      { kind: "json", value: resultRecord(reply, { sessionId }), gate: terminalGate },
    ],
  };
}

async function startClaudeRow(
  t: TestContext,
  fixture: K04Fixture,
  scenario: Q01Scenario,
): Promise<Q01ProviderRuntime> {
  const providerHome = join(fixture.rootDirectory, "provider-home");
  await mkdir(providerHome, { recursive: true, mode: 0o700 });
  const fake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    claudeTurnPlan(
      fixture.workingDirectory,
      CLAUDE_FIRST_SESSION,
      CLAUDE_INPUT_IDS[0],
      scenario.firstInput,
      scenario.firstReply,
      TERMINAL_GATES[0],
    ),
    claudeTurnPlan(
      fixture.workingDirectory,
      CLAUDE_FIRST_SESSION,
      CLAUDE_INPUT_IDS[1],
      scenario.continuationInput,
      scenario.continuationReply,
      TERMINAL_GATES[1],
    ),
    claudeTurnPlan(
      fixture.workingDirectory,
      CLAUDE_PARALLEL_SESSION,
      CLAUDE_INPUT_IDS[2],
      scenario.parallelInput,
      scenario.parallelReply,
      TERMINAL_GATES[2],
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
      Q01_PROVIDER_KIND: "claude",
      Q01_CLAUDE_EXECUTABLE: fake.executablePath,
      Q01_CONNECTOR_STATE: fixture.connectorStateDirectory,
      K04_WEBHOOK_TOKEN,
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 2_000,
    forcedStopMs: 3_000,
  });
  const webhookUrl = `http://127.0.0.1:${fixture.webhookPort}/webhook`;
  await managed.waitForOutput("stdout", `Connector webhook: ${webhookUrl}\n`, 10_000);
  fixedAssertion(managed.stderr().length === 0, "Q01 Claude connector emitted stderr");
  return {
    process: managed,
    webhookUrl,
    diagnostics: () => ({
      launches: fake.launches.map((launch) => ({
        mode: launch.mode,
        stdinClosed: launch.stdinClosed,
        stdinRecordCount: launch.mode === "turn" ? launch.stdinRecords.length : undefined,
        descendant: launch.descendantPid !== undefined,
      })),
    }),
    prepareTerminalUnit: async (count) => {
      const terminalGate = TERMINAL_GATES[count - 1];
      fixedAssertion(terminalGate !== undefined, "Q01 Claude terminal gate was invalid");
      await fake.waitForBarrier(terminalGate as string);
      const launch = fake.launches.filter((candidate) => candidate.mode === "turn")[count - 1];
      fixedAssertion(launch !== undefined, "Q01 Claude launch was not observed");
      const unit = await observeUnit(
        (launch as NonNullable<typeof launch>).pid,
        (launch as NonNullable<typeof launch>).descendantPid,
        "parent",
      );
      fake.release(terminalGate as string);
      return unit;
    },
    assertTerminalUnitGone: (count, unit) => {
      const turns = fake.launches.filter((launch) => launch.mode === "turn");
      fixedAssertion(turns.length === count, "Q01 Claude launch count was invalid");
      fixedAssertion(
        turns.slice(0, count).every((launch) => launch.stdinClosed),
        "Q01 Claude stdin remained open at terminal reporting",
      );
      assertUnitGone(unit);
    },
    assertProtocol: () => {
      const launches = fake.launches;
      const version = launches.filter((launch) => launch.mode === "version");
      const turns = launches.filter((launch) => launch.mode === "turn");
      assert.equal(version.length, 1);
      assert.deepEqual(version[0]?.arguments, ["--version"]);
      assert.equal(turns.length, 3);
      assert.deepEqual(
        turns.map((launch) => launch.arguments),
        [
          exactClaudeArguments("start", "read-only", CLAUDE_FIRST_SESSION),
          exactClaudeArguments("resume", "read-only", CLAUDE_FIRST_SESSION),
          exactClaudeArguments("start", "read-only", CLAUDE_PARALLEL_SESSION),
        ],
      );
      fixedAssertion(
        JSON.stringify(turns.map((launch) => launch.stdinRecords)) ===
          JSON.stringify([
            [
              JSON.stringify(
                inputRecord(scenario.firstInput, CLAUDE_FIRST_SESSION, CLAUDE_INPUT_IDS[0]),
              ),
            ],
            [
              JSON.stringify(
                inputRecord(scenario.continuationInput, CLAUDE_FIRST_SESSION, CLAUDE_INPUT_IDS[1]),
              ),
            ],
            [
              JSON.stringify(
                inputRecord(scenario.parallelInput, CLAUDE_PARALLEL_SESSION, CLAUDE_INPUT_IDS[2]),
              ),
            ],
          ]),
        "Q01 Claude stdin protocol was invalid",
      );
      assert.ok(turns.every((launch) => launch.stdinClosed));
      const processMetadata = JSON.stringify(
        launches.map((launch) => ({
          arguments: launch.arguments,
          environment: launch.environment,
        })),
      );
      for (const marker of [
        scenario.firstInput,
        scenario.parallelInput,
        scenario.continuationInput,
        scenario.firstReply,
        scenario.parallelReply,
        scenario.continuationReply,
        K04_WEBHOOK_TOKEN,
      ]) {
        assert.equal(processMetadata.includes(marker), false);
      }
    },
    stop: async () => {
      assert.deepEqual(
        await managed.stop(),
        { code: 0, signal: null },
        "Q01 Claude connector did not stop cleanly",
      );
      fixedAssertion(managed.stderr().length === 0, "Q01 Claude connector emitted stderr");
    },
  };
}

export const CLAUDE_Q01_PROVIDER_ROW: Q01ProviderRow = {
  key: "claude",
  name: "Claude Code",
  start: startClaudeRow,
};

function assertTerminalState(fixture: K04Fixture, messageId: string): void {
  const state = fixture.central.v2MessageState(messageId);
  assert.equal(state.terminalOutcome, "replied");
  assert.equal(state.acknowledged, true);
  assert.ok(typeof state.replyMessageId === "string");
}

function synchronizeFixtureClock(fixture: K04Fixture): void {
  const systemSeconds = Math.floor(Date.now() / 1_000);
  if (systemSeconds > fixture.central.clock()) {
    fixture.central.advanceClock(systemSeconds - fixture.central.clock());
  }
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
    fetchBarrier: "reply_before_request",
  });
  synchronizeFixtureClock(fixture);
  await enrollK04Gateway(fixture, gateway.endpoint);

  synchronizeFixtureClock(fixture);
  const firstUnitReady = provider.prepareTerminalUnit(1);
  const first = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000071001",
    scenario.firstInput,
  );
  const firstUnit = await firstUnitReady;
  await gateway.control.waitForFetchBarrier("reply_before_request");
  provider.assertTerminalUnitGone(1, firstUnit);
  gateway.control.releaseFetchBarrier("reply_before_request");
  try {
    await waitForK04Acknowledgement(fixture, first.messageId);
  } catch (error) {
    throw new Error(
      `Q01 first turn did not finish: state=${JSON.stringify(fixture.central.v2MessageState(first.messageId))} operations=${JSON.stringify(gateway.control.operations())} provider=${JSON.stringify(provider.diagnostics())}`,
      { cause: error },
    );
  }
  const firstReply = await receiveK04SenderMessage(fixture, first.messageId);
  fixedAssertion(
    JSON.stringify(firstReply.payload) === JSON.stringify({ text: scenario.firstReply }),
    "Q01 first reply payload was invalid",
  );

  assert.equal(typeof firstReply.id, "string");
  const firstReplyId = firstReply.id as string;
  synchronizeFixtureClock(fixture);
  const continuationUnitReady = provider.prepareTerminalUnit(2);
  const continuation = await replyToK04SenderMessage(
    fixture,
    firstReplyId,
    scenario.continuationInput,
  );
  assert.equal(continuation.conversationId, first.conversationId);
  const continuationUnit = await continuationUnitReady;
  await gateway.control.waitForFetchBarrier("reply_before_request");
  provider.assertTerminalUnitGone(2, continuationUnit);
  gateway.control.releaseFetchBarrier("reply_before_request");
  try {
    await waitForK04Acknowledgement(fixture, continuation.messageId);
  } catch (error) {
    throw new Error(
      `Q01 continuation did not finish: state=${JSON.stringify(fixture.central.v2MessageState(continuation.messageId))} operations=${JSON.stringify(gateway.control.operations())} provider=${JSON.stringify(provider.diagnostics())}`,
      { cause: error },
    );
  }
  const continuationReply = await receiveK04SenderMessage(fixture, continuation.messageId);
  fixedAssertion(
    JSON.stringify(continuationReply.payload) ===
      JSON.stringify({ text: scenario.continuationReply }),
    "Q01 continuation reply payload was invalid",
  );

  synchronizeFixtureClock(fixture);
  const parallelUnitReady = provider.prepareTerminalUnit(3);
  const parallel = await startK04InboundConversation(
    fixture,
    "00000000-0000-4000-8000-000000071002",
    scenario.parallelInput,
  );
  const parallelUnit = await parallelUnitReady;
  await gateway.control.waitForFetchBarrier("reply_before_request");
  provider.assertTerminalUnitGone(3, parallelUnit);
  gateway.control.releaseFetchBarrier("reply_before_request");
  try {
    await waitForK04Acknowledgement(fixture, parallel.messageId);
  } catch (error) {
    throw new Error(
      `Q01 parallel turn did not finish: state=${JSON.stringify(fixture.central.v2MessageState(parallel.messageId))} operations=${JSON.stringify(gateway.control.operations())} provider=${JSON.stringify(provider.diagnostics())}`,
      { cause: error },
    );
  }
  const parallelReply = await receiveK04SenderMessage(fixture, parallel.messageId);
  fixedAssertion(
    JSON.stringify(parallelReply.payload) === JSON.stringify({ text: scenario.parallelReply }),
    "Q01 parallel reply payload was invalid",
  );

  provider.assertProtocol();
  for (const messageId of [first.messageId, parallel.messageId, continuation.messageId]) {
    assertTerminalState(fixture, messageId);
  }
  const terminalOperations = gateway.control
    .operations()
    .filter((operation) => ["reply", "complete", "outcome", "ack"].includes(operation));
  assert.equal(terminalOperations.filter((operation) => operation === "reply").length, 3);
  assert.equal(terminalOperations.filter((operation) => operation === "complete").length, 0);
  assert.equal(terminalOperations.filter((operation) => operation === "outcome").length, 0);
  assert.equal(terminalOperations.filter((operation) => operation === "ack").length, 3);
  let unacknowledgedReplies = 0;
  for (const operation of terminalOperations) {
    if (operation === "reply") unacknowledgedReplies += 1;
    else if (operation === "ack") unacknowledgedReplies -= 1;
    assert.ok(unacknowledgedReplies >= 0, "Q01 observed an ack before its terminal reply");
  }
  assert.equal(unacknowledgedReplies, 0);

  await provider.stop();
  assert.deepEqual(
    await gateway.process.stop(),
    { code: 0, signal: null },
    "Q01 gateway did not stop cleanly",
  );
  fixedAssertion(
    !provider.process.stdoutTruncated() && !provider.process.stderrTruncated(),
    "Q01 connector output capture was truncated",
  );
  fixedAssertion(
    !gateway.process.stdoutTruncated() && !gateway.process.stderrTruncated(),
    "Q01 gateway output capture was truncated",
  );
  await scanK04Artifacts({
    fixture,
    captures: [
      { name: `${row.key}-connector-stdout`, value: provider.process.stdout() },
      { name: `${row.key}-connector-stderr`, value: provider.process.stderr() },
      { name: "q01-gateway-stdout", value: gateway.process.stdout() },
      { name: "q01-gateway-stderr", value: gateway.process.stderr() },
    ],
    markers: [
      { name: "q01-content-prefix", value: CONTENT_PREFIX },
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
  const providerKind = process.env.Q01_PROVIDER_KIND;
  const executablePath =
    providerKind === "codex" ? process.env.Q01_CODEX_EXECUTABLE : process.env.Q01_CLAUDE_EXECUTABLE;
  const webhookToken = process.env.K04_WEBHOOK_TOKEN;
  if (
    webhookPortText === undefined ||
    !/^[1-9][0-9]{3,4}$/u.test(webhookPortText) ||
    workingDirectory === undefined ||
    stateDirectory === undefined ||
    executablePath === undefined ||
    webhookToken === undefined ||
    (providerKind !== "codex" && providerKind !== "claude")
  ) {
    throw new Error("Q01 connector child configuration is invalid");
  }
  const provider = await (async () => {
    if (providerKind === "codex") {
      const module = await loadCx03Production("Q01-Codex");
      return await module.createCodexAppServerAdapterForTest({
        workingDirectory,
        policy: "read-only",
        inheritedEnvironment: process.env,
        webhookTokenEnvironmentName: "K04_WEBHOOK_TOKEN",
        connectorPackageVersion: "0.0.0-private",
        fixtureExecutablePath: executablePath,
      });
    }
    const module = await loadCl03Production("Q01-Claude");
    let sessionIndex = 0;
    let inputIndex = 0;
    return await module.createClaudeCodeAdapterForTest({
      workingDirectory,
      policy: "read-only",
      inheritedEnvironment: process.env,
      webhookTokenEnvironmentName: "K04_WEBHOOK_TOKEN",
      connectorPackageVersion: "0.0.0-private",
      fixtureExecutablePath: executablePath,
      uuidForTest(kind) {
        const value =
          kind === "session"
            ? [CLAUDE_FIRST_SESSION, CLAUDE_PARALLEL_SESSION][sessionIndex++]
            : CLAUDE_INPUT_IDS[inputIndex++];
        if (value === undefined) throw new Error("Q01 Claude UUID plan exhausted");
        return value;
      },
    });
  })();
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
    providerKind,
    webhookPort: Number(webhookPortText),
    webhookToken,
    workingDirectory,
    policy: "read-only",
    gatewayEndpoint: "http://127.0.0.1:8787/mcp",
    stateDirectory,
    provider: connectorProvider,
  });
  process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);
  const signal = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  const received = await Promise.race([signal, connector.waitForFatal()]);
  await connector.shutdown(received);
  await provider.close();
}

if (process.argv[2] === "q01-connector-child") await runConnectorChild();
