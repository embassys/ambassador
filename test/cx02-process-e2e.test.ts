import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startConnectorRuntime } from "../packages/connector-core/src/connector.js";
import type { ProviderPort } from "../packages/connector-core/src/runtime-types.js";
import {
  type CodexAdapterPort,
  CX02_DEADLINE_MS,
  CX02_THREAD_ID,
  CX02_TURN_ID,
  createCx02Adapter,
  type FakeCodexProcessPlan,
  handshakeExchanges,
  loadCx03Production,
  startFakeCodexAppServer,
  startRequest,
  syntheticCx02Environment,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function observeProviderEvents(adapter: CodexAdapterPort, observed: unknown[]): ProviderPort {
  const observe = async function* (source: AsyncIterable<unknown>): AsyncIterable<unknown> {
    for await (const event of source) {
      observed.push(structuredClone(event));
      yield event;
    }
  };
  return {
    spawnRecord: adapter.spawnRecord,
    get containmentAttempts() {
      return adapter.containmentAttempts;
    },
    get postTerminalDeliveries() {
      return adapter.postTerminalDeliveries;
    },
    start(request) {
      return observe(adapter.start(request as never));
    },
    resume(request) {
      return observe(adapter.resume(request as never));
    },
    recover(request) {
      return observe(adapter.recover(request as never));
    },
    async cancel(request) {
      return await adapter.cancel(request as never);
    },
    async contain(executionId) {
      return await adapter.contain(executionId);
    },
  };
}

import { startFakeConnectorGateway } from "./support/connector/index.js";
import { K02_TOKEN, k02Message, ManualK02Clock } from "./support/connector/k02-production.js";

function threadStarted(cwd: string, threadId = CX02_THREAD_ID): unknown {
  return { method: "thread/started", params: { thread: validThread(cwd, threadId) } };
}

function turnStarted(threadId = CX02_THREAD_ID, turnId = CX02_TURN_ID): unknown {
  return {
    method: "turn/started",
    params: { threadId, turn: validTurn(turnId) },
  };
}

function turnCompleted(text: string, threadId = CX02_THREAD_ID, turnId = CX02_TURN_ID): unknown {
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

function exactThreadResumeRequest(cwd: string): Readonly<Record<string, unknown>> {
  return {
    id: 2,
    method: "thread/resume",
    params: {
      threadId: CX02_THREAD_ID,
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    },
  };
}

function exactThreadStartRequest(cwd: string): Readonly<Record<string, unknown>> {
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

function exactTurnStartRequest(
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

function terminalPlan(
  cwd: string,
  options: {
    threadId?: string;
    turnId?: string;
    responseText?: string;
    requestText?: string;
    terminalStatus?: "completed" | "failed" | "interrupted";
    terminalGate?: string;
    onStdinEnd?: "exit" | "linger" | "resist";
    spawnDescendant?: boolean;
    killDescendantOnStdinEnd?: boolean;
    writesAfterStdinEnd?: Extract<
      FakeCodexProcessPlan,
      { kind: "app-server" }
    >["writesAfterStdinEnd"];
  } = {},
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  const threadId = options.threadId ?? CX02_THREAD_ID;
  const turnId = options.turnId ?? CX02_TURN_ID;
  const terminalStatus = options.terminalStatus ?? "completed";
  return {
    kind: "app-server",
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/start",
        expectRequest: exactThreadStartRequest(cwd),
        result: threadSettingsResponse(cwd, threadId),
        afterResponse: [{ kind: "json", value: threadStarted(cwd, threadId) }],
      },
      {
        expectMethod: "turn/start",
        expectRequest: exactTurnStartRequest(
          cwd,
          threadId,
          options.requestText ?? "CX02 untrusted input",
        ),
        result: { turn: validTurn(turnId) },
        afterResponse: [
          { kind: "json", value: turnStarted(threadId, turnId) },
          {
            kind: "json",
            value:
              terminalStatus === "completed"
                ? turnCompleted(options.responseText ?? "terminal reply", threadId, turnId)
                : {
                    method: "turn/completed",
                    params: {
                      threadId,
                      turn: validTurn(turnId, terminalStatus),
                    },
                  },
            ...(options.terminalGate === undefined ? {} : { gate: options.terminalGate }),
          },
        ],
      },
    ],
    ...(options.onStdinEnd === undefined ? {} : { onStdinEnd: options.onStdinEnd }),
    ...(options.spawnDescendant === undefined ? {} : { spawnDescendant: options.spawnDescendant }),
    ...(options.killDescendantOnStdinEnd === undefined
      ? {}
      : { killDescendantOnStdinEnd: options.killDescendantOnStdinEnd }),
    ...(options.writesAfterStdinEnd === undefined
      ? {}
      : { writesAfterStdinEnd: options.writesAfterStdinEnd }),
  };
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function waitForLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.split("\n").includes(line)) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      reject(new Error(`CX02 owner worker exited before ready: ${code}/${signal}`));
    });
  });
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("fake Codex descendant survived owner death");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("CX02-X24 hard owner death closes the attached fake App Server unit", async (t) => {
  await loadCx03Production("CX02-CX03:X24");
  const cwd = process.cwd();
  const fake = await startFakeCodexAppServer(t, [
    { kind: "version", stdout: "codex-cli 0.149.0\n" },
    terminalPlan(cwd, {
      terminalGate: "never_release",
      spawnDescendant: true,
      killDescendantOnStdinEnd: true,
    }),
  ]);
  const workerPath = fileURLToPath(
    new URL("./support/codex-app-server/adapter-owner-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [workerPath, fake.executablePath, cwd], {
    cwd,
    env: syntheticCx02Environment("owner-process"),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const childExit = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExit;
  });
  await Promise.all([waitForLine(child, '{"ready":true}'), fake.waitForDescendants(1)]);
  const descendantPid = fake.launches.at(-1)?.descendantPid;
  assert.ok(descendantPid !== undefined);
  child.kill("SIGKILL");
  await childExit;
  await fake.waitForStdinClosed(1);
  await waitForPidGone(descendantPid);
});

test("CX02-X25 runs two turns in one thread and two conversations through the foundation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx02-chain-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
  const threadTwo = "019c0000-0000-7000-8000-000000000011";
  const turnTwo = "019c0000-0000-7000-8000-000000000012";
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X25", {
    appPlan: terminalPlan(workingDirectory, {
      responseText: "first reply",
      requestText: "first input",
      terminalGate: "parallel_release",
    }),
  });
  fake.enqueue(
    terminalPlan(workingDirectory, {
      threadId: threadTwo,
      turnId: turnTwo,
      responseText: "parallel reply",
      requestText: "parallel input",
      terminalGate: "parallel_release",
    }),
  );
  const providerEvents: unknown[] = [];
  const connector = await startConnectorRuntime({
    providerKind: "codex",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory,
    policy: "read-only",
    gatewayEndpoint: gateway.endpoint,
    stateDirectory,
    provider: observeProviderEvents(adapter, providerEvents),
  });
  t.after(async () => await connector.close());
  gateway.enqueueMessage(k02Message("cx02_chain_1", "cx02_conversation_a", "first input"));
  gateway.enqueueMessage(k02Message("cx02_parallel_1", "cx02_conversation_b", "parallel input"));
  const wakes = await Promise.all([
    gateway.sendWake(connector.webhookUrl, "cx02_chain_1"),
    gateway.sendWake(connector.webhookUrl, "cx02_parallel_1", {
      timestampSeconds: Math.floor(Date.now() / 1_000) + 1,
    }),
  ]);
  assert.deepEqual(
    wakes.map((response) => response.status),
    [202, 202],
  );
  await fake.waitForLaunches(3);
  await fake.waitForRequests(8);
  assert.equal(
    fake.launches.filter(
      (launch) =>
        launch.mode === "app-server" &&
        launch.requests.some((request) => request.method === "turn/start"),
    ).length,
    2,
  );
  fake.releaseAll("parallel_release");
  await connector.waitForIdle();
  const firstTombstone = gateway.tombstone("cx02_chain_1");
  const parallelTombstone = gateway.tombstone("cx02_parallel_1");
  assert.equal(firstTombstone?.outcome, "replied");
  assert.equal(parallelTombstone?.outcome, "replied");
  const continuationMessage = k02Message(
    "cx02_chain_2",
    "cx02_conversation_a",
    "second input",
    firstTombstone?.reply_message_id ?? null,
  );
  assert.equal(continuationMessage.in_reply_to_message_id, firstTombstone?.reply_message_id);
  gateway.enqueueMessage(continuationMessage);
  fake.enqueue({
    kind: "app-server",
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/resume",
        expectRequest: exactThreadResumeRequest(workingDirectory),
        result: threadSettingsResponse(workingDirectory),
      },
      {
        expectMethod: "turn/start",
        expectRequest: exactTurnStartRequest(workingDirectory, CX02_THREAD_ID, "second input"),
        result: { turn: validTurn("019c0000-0000-7000-8000-000000000003") },
        afterResponse: [
          {
            kind: "json",
            value: turnStarted(CX02_THREAD_ID, "019c0000-0000-7000-8000-000000000003"),
          },
          {
            kind: "json",
            value: turnCompleted(
              "second reply",
              CX02_THREAD_ID,
              "019c0000-0000-7000-8000-000000000003",
            ),
          },
        ],
      },
    ],
  });
  const secondWake = await gateway.sendWake(connector.webhookUrl, "cx02_chain_2", {
    timestampSeconds: Math.floor(Date.now() / 1_000) + 2,
  });
  assert.equal(secondWake.status, 202);
  await connector.waitForIdle();
  assert.equal(gateway.tombstone("cx02_chain_2")?.outcome, "replied");
  const methods = fake.launches.flatMap((launch) =>
    launch.requests.map((request) => request.method),
  );
  assert.equal(methods.filter((method) => method === "thread/start").length, 2);
  assert.equal(methods.filter((method) => method === "thread/resume").length, 1);
  const resumeLaunch = fake.launches.find((launch) =>
    launch.requests.some((request) => request.method === "thread/resume"),
  );
  assert.ok(resumeLaunch !== undefined);
  assert.deepEqual(
    resumeLaunch.requests.filter((request) =>
      ["thread/resume", "turn/start"].includes(String(request.method)),
    ),
    [
      exactThreadResumeRequest(workingDirectory),
      exactTurnStartRequest(workingDirectory, CX02_THREAD_ID, "second input"),
    ],
  );
  const terminalProviderEvents = providerEvents.filter((event) =>
    ["reply", "failed", "uncertain", "completed_without_reply", "cancelled"].includes(
      String(eventName(event)),
    ),
  );
  assert.equal(terminalProviderEvents.length, 3);
  assert.equal(
    new Set(terminalProviderEvents.map((event) => (event as { execution_id: string }).execution_id))
      .size,
    3,
  );
  assert.deepEqual(
    providerEvents
      .filter((event) => eventName(event) === "turn_bound")
      .map((event) => (event as { provider_turn_id: string }).provider_turn_id)
      .sort(),
    [CX02_TURN_ID, "019c0000-0000-7000-8000-000000000003", turnTwo].sort(),
  );
  assert.equal(gateway.calls.filter((call) => call.name === "ack_message").length, 3);
  assert.equal(gateway.calls.filter((call) => call.name === "reply_message").length, 3);
  assert.equal(gateway.calls.filter((call) => call.name === "complete_message").length, 0);
  assert.deepEqual(
    gateway.calls
      .filter((call) => call.name === "reply_message")
      .map((call) => call.arguments.text)
      .sort(),
    ["first reply", "parallel reply", "second reply"].sort(),
  );
  for (const messageId of ["cx02_chain_1", "cx02_parallel_1", "cx02_chain_2"]) {
    const terminalIndex = gateway.calls.findIndex(
      (call) =>
        (call.name === "reply_message" || call.name === "complete_message") &&
        call.arguments.message_id === messageId,
    );
    const ackIndex = gateway.calls.findIndex(
      (call) => call.name === "ack_message" && call.arguments.message_id === messageId,
    );
    assert.ok(terminalIndex >= 0 && ackIndex > terminalIndex);
  }
});

test("CX02-X27 proves child and descendant teardown before releasing any terminal", async (t) => {
  const cwd = process.cwd();
  const cases: readonly {
    name: string;
    plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }>;
    containmentEmpty: boolean;
    terminal: "reply" | "failed" | "uncertain" | null;
    containmentExpected: boolean;
  }[] = [
    {
      name: "normal",
      plan: terminalPlan(cwd),
      containmentEmpty: true,
      terminal: "reply",
      containmentExpected: false,
    },
    {
      name: "exact failed terminal",
      plan: terminalPlan(cwd, { terminalStatus: "failed" }),
      containmentEmpty: true,
      terminal: "failed",
      containmentExpected: false,
    },
    {
      name: "exact interrupted terminal",
      plan: terminalPlan(cwd, { terminalStatus: "interrupted" }),
      containmentEmpty: true,
      terminal: "uncertain",
      containmentExpected: false,
    },
    {
      name: "linger",
      plan: terminalPlan(cwd, { onStdinEnd: "linger" }),
      containmentEmpty: true,
      terminal: "reply",
      containmentExpected: true,
    },
    {
      name: "descendant",
      plan: terminalPlan(cwd, { spawnDescendant: true }),
      containmentEmpty: true,
      terminal: "reply",
      containmentExpected: true,
    },
    {
      name: "late conflicting control",
      plan: terminalPlan(cwd, {
        writesAfterStdinEnd: [
          {
            kind: "json",
            value: {
              method: "turn/completed",
              params: { threadId: "wrong", turn: validTurn("wrong", "completed") },
            },
          },
        ],
      }),
      containmentEmpty: true,
      terminal: "uncertain",
      containmentExpected: false,
    },
    {
      name: "resists containment",
      plan: {
        ...terminalPlan(cwd, { onStdinEnd: "resist", spawnDescendant: true }),
        containmentForTest: "fail",
      },
      containmentEmpty: false,
      terminal: null,
      containmentExpected: true,
    },
  ];
  for (const vector of cases) {
    let containCalls = 0;
    let emptyChecks = 0;
    let fakeForContainment: Awaited<ReturnType<typeof createCx02Adapter>>["fake"] | undefined;
    const clock = new ManualK02Clock(CX02_DEADLINE_MS - 100_000);
    const created = await createCx02Adapter(t, "CX02-CX03:X27", {
      appPlan: vector.plan,
      clock,
      containmentForTest: {
        async contain() {
          containCalls += 1;
          assert.ok(fakeForContainment !== undefined);
          return await fakeForContainment.containLatestUnit();
        },
        isEmpty() {
          emptyChecks += 1;
          return fakeForContainment?.isLatestUnitEmpty() ?? false;
        },
      },
    });
    fakeForContainment = created.fake;
    const { fake, adapter } = created;
    const events: unknown[] = [];
    let failure: unknown;
    const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
    events.push((await iterator.next()).value, (await iterator.next()).value);
    let terminalSettled = false;
    const terminal = iterator.next().then(
      (result) => {
        terminalSettled = true;
        if (!result.done) events.push(result.value);
      },
      (error: unknown) => {
        terminalSettled = true;
        failure = error;
      },
    );
    await fake.waitForStdinClosed(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (vector.containmentExpected) {
      assert.equal(terminalSettled, false, vector.name);
      clock.advance(999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(containCalls, 0, vector.name);
      assert.equal(terminalSettled, false, vector.name);
      clock.advance(1);
      while (containCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (vector.containmentEmpty) {
        await terminal;
      } else {
        clock.advance(1_999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(terminalSettled, false, vector.name);
        clock.advance(1);
        await terminal;
      }
    } else {
      await terminal;
    }
    assert.equal(fake.launches.at(-1)?.stdinClosed, true, vector.name);
    const observedTerminal = events.findLast((event) =>
      ["reply", "failed", "uncertain", "completed_without_reply", "cancelled"].includes(
        String(
          event !== null && typeof event === "object" ? (event as { event?: unknown }).event : "",
        ),
      ),
    );
    if (vector.terminal === null) {
      assert.equal(observedTerminal, undefined, vector.name);
      assert.match(String(failure), /contain|cleanup|unit/u, vector.name);
    } else {
      assert.equal(failure, undefined, vector.name);
      assert.equal(eventName(observedTerminal), vector.terminal, vector.name);
      assert.equal(fake.isLatestUnitEmpty(), true, vector.name);
    }
    assert.ok(emptyChecks >= 1, vector.name);
    assert.equal(containCalls > 0, vector.containmentExpected, vector.name);
  }
});
