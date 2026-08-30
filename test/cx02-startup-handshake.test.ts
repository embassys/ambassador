import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startConnectorRuntime } from "../packages/connector-core/src/connector.js";
import type { ProviderPort } from "../packages/connector-core/src/runtime-types.js";
import {
  type CodexAppServerSpawnOptionsForTest,
  CX02_DEADLINE_MS,
  CX02_EXECUTION_ID,
  CX02_THREAD_ID,
  CX02_TURN_ID,
  collectEvents,
  createCx02Adapter,
  type FakeCodexAppServer,
  type FakeCodexExchange,
  type FakeCodexProcessPlan,
  handshakeExchanges,
  initializeRequest,
  resumeRequest,
  startFakeCodexAppServer,
  startRequest,
  syntheticCx02Environment,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";
import { startFakeConnectorGateway } from "./support/connector/index.js";
import { K02_TOKEN, k02Message, ManualK02Clock } from "./support/connector/k02-production.js";

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

function threadStarted(cwd: string, threadId = CX02_THREAD_ID): Readonly<Record<string, unknown>> {
  return {
    method: "thread/started",
    params: { thread: validThread(cwd, threadId) },
  };
}

function turnStarted(
  threadId = CX02_THREAD_ID,
  turnId = CX02_TURN_ID,
): Readonly<Record<string, unknown>> {
  return {
    method: "turn/started",
    params: { threadId, turn: validTurn(turnId) },
  };
}

function terminalReply(
  text = "CX02 exact reply",
  threadId = CX02_THREAD_ID,
  turnId = CX02_TURN_ID,
): Readonly<Record<string, unknown>> {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: validTurn(turnId, "completed", [
        { id: "cx02_item_1", type: "agentMessage", phase: "final_answer", text },
      ]),
    },
  };
}

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
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

function threadResumeRequest(
  cwd: string,
  threadId = CX02_THREAD_ID,
): Readonly<Record<string, unknown>> {
  return {
    id: 2,
    method: "thread/resume",
    params: {
      threadId,
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    },
  };
}

function turnStartRequest(
  cwd: string,
  text: string,
  policy: "read-only" | "workspace-write",
): Readonly<Record<string, unknown>> {
  return {
    id: 3,
    method: "turn/start",
    params: {
      threadId: CX02_THREAD_ID,
      input: [{ type: "text", text, text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy:
        policy === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
    },
  };
}

function validStartPlan(
  cwd: string,
  options: {
    text?: string;
    policy?: "read-only" | "workspace-write";
    threadNotificationFirst?: boolean;
    turnNotificationFirst?: boolean;
  } = {},
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  const text = options.text ?? "CX02 untrusted input";
  const policy = options.policy ?? "read-only";
  const threadNotification = { kind: "json", value: threadStarted(cwd) } as const;
  const turnNotification = { kind: "json", value: turnStarted() } as const;
  return {
    kind: "app-server",
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/start",
        expectRequest: threadStartRequest(cwd),
        ...(options.threadNotificationFirst
          ? { beforeResponse: [threadNotification] }
          : { afterResponse: [threadNotification] }),
        result: threadSettingsResponse(cwd),
      },
      {
        expectMethod: "turn/start",
        expectRequest: turnStartRequest(cwd, text, policy),
        ...(options.turnNotificationFirst
          ? { beforeResponse: [turnNotification] }
          : { afterResponse: [turnNotification] }),
        result: { turn: validTurn() },
        afterResponse: [
          ...(options.turnNotificationFirst ? [] : [turnNotification]),
          { kind: "json", value: terminalReply() },
        ],
      },
    ],
  };
}

test("CX02-X01 pins executable identity and rejects every unavailable version preflight", async (t) => {
  const cwd = process.cwd();
  const versions: readonly Extract<FakeCodexProcessPlan, { kind: "version" }>[] = [
    { kind: "version", stdout: "codex-cli 0.148.0\n" },
    { kind: "version", stdout: "codex-cli 0.149.0-beta.1\n" },
    { kind: "version", stdout: "codex-cli 0.150.0\n" },
    { kind: "version", stdout: `${"x".repeat(65)}\n` },
    { kind: "version", stderr: "probe failed", exitCode: 1 },
    { kind: "version", hold: true },
  ];
  for (const versionPlan of versions) {
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X01", {
      versionPlan,
      appPlan: validStartPlan(cwd),
    });
    assert.deepEqual(await collectEvents(adapter.start(startRequest())), [
      {
        event: "failed",
        execution_id: CX02_EXECUTION_ID,
        reason_code: "provider_start_failed",
      },
    ]);
    assert.equal(fake.launches.filter((launch) => launch.mode === "app-server").length, 0);
  }

  const noExecutable = await createCx02Adapter(t, "CX02-CX03:X01", {
    fixtureExecutablePath: null,
    appPlan: validStartPlan(cwd),
  });
  assert.deepEqual(await collectEvents(noExecutable.adapter.start(startRequest())), [
    { event: "failed", execution_id: CX02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);

  let fakeForMutation: FakeCodexAppServer | undefined;
  fakeForMutation = await startFakeCodexAppServer(t, [
    { kind: "version", stdout: "codex-cli 0.149.0\n" },
    validStartPlan(cwd),
  ]);
  const module = await import("./support/codex-app-server/cx03-production.js").then(
    async ({ loadCx03Production }) => await loadCx03Production("CX02-CX03:X01"),
  );
  const mutationAdapter = await module.createCodexAppServerAdapterForTest({
    workingDirectory: cwd,
    policy: "read-only",
    inheritedEnvironment: syntheticCx02Environment("identity-mutation"),
    webhookTokenEnvironmentName: "CX02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: fakeForMutation.executablePath,
    afterVersionProbeForTest: async () => {
      assert.ok(fakeForMutation !== undefined);
      await appendFile(fakeForMutation.executablePath, "\n");
      await chmod(fakeForMutation.executablePath, 0o700);
    },
  });
  t.after(async () => await mutationAdapter.close());
  assert.deepEqual(await collectEvents(mutationAdapter.start(startRequest())), [
    { event: "failed", execution_id: CX02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);
});

test("CX02-X02 launches one exact direct App Server child with scrubbed sealed settings", async (t) => {
  const cwd = process.cwd();
  const inherited = {
    ...syntheticCx02Environment("launch-record"),
    CX02_WEBHOOK_TOKEN: "a".repeat(48),
    OPENAI_API_KEY: "forbidden-api-key",
    NODE_OPTIONS: "--import=forbidden",
    A2A_REMOTE_COMMAND: "forbidden",
  };
  const actualSpawns: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly options: CodexAppServerSpawnOptionsForTest;
  }[] = [];
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X02", {
    appPlan: validStartPlan(cwd),
    inheritedEnvironment: inherited,
    spawnAppServerForTest(executable, arguments_, options) {
      actualSpawns.push({
        executable,
        arguments: [...arguments_],
        options: structuredClone(options),
      });
      return spawn(executable, [...arguments_], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: options.shell,
        stdio: [...options.stdio],
      });
    },
  });
  await collectEvents(adapter.start(startRequest()));
  const expectedEnvironment = syntheticCx02Environment("launch-record");
  assert.deepEqual(actualSpawns, [
    {
      executable: fake.executablePath,
      arguments: ["app-server", "--listen", "stdio://", "--strict-config"],
      options: {
        cwd,
        env: expectedEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    },
  ]);
  assert.ok(!JSON.stringify(actualSpawns).includes("CX02 untrusted input"));
  assert.ok(
    Object.keys(actualSpawns[0]?.options.env ?? {}).every((name) => Object.hasOwn(inherited, name)),
  );
});

test("CX02-X03 keeps the pinned stable schema test-only and out of production package surfaces", async (t) => {
  const schema = await import("node:fs/promises").then(
    async ({ readFile }) =>
      await readFile(
        "test/fixtures/codex-app-server/0.149.0/codex_app_server_protocol.v2.schemas.json",
      ),
  );
  const digest = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(schema).digest("hex"),
  );
  assert.equal(digest, "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9");
  const source = await import("node:fs/promises").then(
    async ({ readFile }) =>
      await readFile("test/fixtures/codex-app-server/0.149.0/SOURCE.md", "utf8"),
  );
  assert.match(source, /Apache-2\.0/u);
  const { adapter } = await createCx02Adapter(t, "CX02-CX03:X03", {
    appPlan: validStartPlan(process.cwd()),
  });
  assert.ok(adapter !== undefined);
  const packageSource = await import("node:fs/promises").then(
    async ({ readdir }) => await readdir("packages/codex-connector", { recursive: true }),
  );
  assert.ok(packageSource.every((entry) => !String(entry).includes("schemas.json")));
});

test("CX02-X04 enforces the exact initialize ordering and warning opt-out matrix", async (t) => {
  const cwd = process.cwd();
  const warning = { method: "warning", params: { message: "bounded warning", threadId: null } };
  const configWarning = { method: "configWarning", params: { summary: "must be opted out" } };
  const variants: {
    name: string;
    exchanges: readonly FakeCodexExchange[];
    valid: boolean;
  }[] = [
    { name: "valid", exchanges: handshakeExchanges(), valid: true },
    {
      name: "early warning",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [{ kind: "json", value: warning }],
          result: {},
        },
      ],
      valid: false,
    },
    {
      name: "early server request",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [
            {
              kind: "json",
              value: {
                id: "early-approval",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: CX02_THREAD_ID,
                  turnId: CX02_TURN_ID,
                  itemId: "early_item",
                },
              },
            },
          ],
          result: {},
        },
      ],
      valid: false,
    },
    {
      name: "config warning before initialized",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [{ kind: "json", value: configWarning }],
          result: {},
        },
      ],
      valid: false,
    },
    {
      name: "config warning after initialized",
      exchanges: handshakeExchanges().map((exchange, index) =>
        index === 1
          ? {
              ...exchange,
              afterResponse: [{ kind: "json", value: configWarning }],
            }
          : exchange,
      ),
      valid: false,
    },
    {
      name: "wrong response ID",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [{ kind: "json", value: { id: 99, result: {} } }],
        },
      ],
      valid: false,
    },
    {
      name: "initialize error",
      exchanges: [{ expectMethod: "initialize", error: { code: -32_000, message: "failed" } }],
      valid: false,
    },
    {
      name: "malformed response",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [{ kind: "utf8", value: "{not-json}\n" }],
        },
      ],
      valid: false,
    },
    {
      name: "missing response",
      exchanges: [{ expectMethod: "initialize", exitCodeAfter: 0 }],
      valid: false,
    },
    {
      name: "duplicate response",
      exchanges: [
        {
          expectMethod: "initialize",
          result: {},
          afterResponse: [{ kind: "json", value: { id: 1, result: {} } }],
        },
        { expectMethod: "initialized" },
      ],
      valid: false,
    },
  ];
  variants.push({
    name: "allowed warning after initialized",
    exchanges: handshakeExchanges(),
    valid: true,
  });
  for (const variant of variants) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: variant.valid
        ? [
            ...variant.exchanges,
            {
              expectMethod: "thread/start",
              ...(variant.name === "allowed warning after initialized"
                ? { beforeResponse: [{ kind: "json" as const, value: warning }] }
                : {}),
              result: threadSettingsResponse(cwd),
              afterResponse: [{ kind: "json", value: threadStarted(cwd) }],
            },
            {
              expectMethod: "turn/start",
              result: { turn: validTurn() },
              afterResponse: [
                { kind: "json", value: turnStarted() },
                { kind: "json", value: terminalReply() },
              ],
            },
          ]
        : ["config warning after initialized", "duplicate response"].includes(variant.name)
          ? [
              ...variant.exchanges,
              {
                expectMethod: "thread/start",
              },
            ]
          : variant.exchanges,
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X04", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    if (variant.valid) assert.equal(eventName(events.at(-1)), "reply", variant.name);
    else {
      assert.deepEqual(events, [
        { event: "failed", execution_id: CX02_EXECUTION_ID, reason_code: "provider_start_failed" },
      ]);
      const requests = fake.launches.at(-1)?.requests ?? [];
      if (["config warning after initialized", "duplicate response"].includes(variant.name)) {
        assert.deepEqual(
          requests.filter((request) => request.method === "thread/start"),
          requests.some((request) => request.method === "thread/start")
            ? [threadStartRequest(cwd)]
            : [],
        );
        assert.equal(
          requests.some((request) =>
            ["thread/resume", "turn/start"].includes(String(request.method)),
          ),
          false,
          variant.name,
        );
      } else {
        assert.equal(
          requests.some((request) =>
            ["thread/start", "thread/resume", "turn/start"].includes(String(request.method)),
          ),
          false,
          variant.name,
        );
      }
      assert.ok(!JSON.stringify(requests).includes("CX02 untrusted input"), variant.name);
    }
  }

  const timeoutClock = new ManualK02Clock(CX02_DEADLINE_MS - 1);
  const timeout = await createCx02Adapter(t, "CX02-CX03:X04", {
    clock: timeoutClock,
    appPlan: {
      kind: "app-server",
      exchanges: [
        {
          expectMethod: "initialize",
          beforeResponse: [{ kind: "json", value: warning, gate: "never_release" }],
        },
      ],
    },
  });
  const timeoutEvents = collectEvents(timeout.adapter.start(startRequest()));
  await timeout.fake.waitForRequests(1);
  timeoutClock.advance(1);
  assert.deepEqual(await timeoutEvents, [
    { event: "failed", execution_id: CX02_EXECUTION_ID, reason_code: "provider_start_failed" },
  ]);
  assert.equal(
    timeout.fake.launches.at(-1)?.requests.some((request) => request.method === "turn/start"),
    false,
  );
});

test("CX02-X05 binds one response-first or notification-first thread before turn input", async (t) => {
  const cwd = process.cwd();
  for (const threadNotificationFirst of [false, true]) {
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X05", {
      appPlan: validStartPlan(cwd, { threadNotificationFirst }),
    });
    const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: {
        event: "session_bound",
        execution_id: CX02_EXECUTION_ID,
        provider_session_id: CX02_THREAD_ID,
      },
    });
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "turn/start"),
      false,
    );
    const remaining: unknown[] = [];
    for (;;) {
      const event = await iterator.next();
      if (event.done) break;
      remaining.push(event.value);
    }
    assert.equal(remaining.filter((event) => eventName(event) === "turn_bound").length, 1);
    assert.equal(
      fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/start").length,
      1,
    );
  }

  for (const notificationFirst of [false, true]) {
    const exactNotification = { kind: "json", value: threadStarted(cwd) } as const;
    const mismatchedNotification = {
      kind: "json",
      value: threadStarted(cwd, "different_thread"),
    } as const;
    const mismatchPlan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/start",
          result: threadSettingsResponse(cwd),
          ...(notificationFirst
            ? { beforeResponse: [mismatchedNotification], afterResponse: [exactNotification] }
            : { afterResponse: [mismatchedNotification] }),
        },
      ],
    };
    const mismatch = await createCx02Adapter(t, "CX02-CX03:X05", {
      appPlan: mismatchPlan,
    });
    const events = await collectEvents(mismatch.adapter.start(startRequest()));
    assert.equal(
      events.filter((event) => eventName(event) === "session_bound").length,
      1,
      notificationFirst ? "notification-first mismatch" : "response-first mismatch",
    );
    assert.equal(
      (
        events.find((event) => eventName(event) === "session_bound") as {
          provider_session_id: string;
        }
      ).provider_session_id,
      notificationFirst ? "different_thread" : CX02_THREAD_ID,
    );
    assert.equal(eventName(events.at(-1)), "failed");
    assert.equal(
      mismatch.fake.launches.at(-1)?.requests.some((request) => request.method === "turn/start"),
      false,
    );
  }
});

test("CX02-X06 never writes input before session publication or replays after either crash side", async (t) => {
  const cwd = process.cwd();
  for (const threadNotificationFirst of [false, true]) {
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X06", {
      appPlan: validStartPlan(cwd, { threadNotificationFirst }),
    });
    const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
    const session = await iterator.next();
    assert.equal(eventName(session.value), "session_bound");
    assert.equal(
      fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/start").length,
      0,
    );
    await iterator.return?.();
    await adapter.close();
    assert.equal(
      fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/start").length,
      0,
    );
    assert.equal(fake.launches.filter((launch) => launch.mode === "app-server").length, 1);
  }

  for (const vector of [
    { name: "before session publication", failStateAfter: "session_bound" as const },
    { name: "after session publication", crashForRecoveryState: "session_binding" as const },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "a2a-cx02-session-crash-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const workingDirectory = join(root, "workspace");
    const stateDirectory = join(root, "state");
    await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
    const initial = await createCx02Adapter(t, "CX02-CX03:X06", {
      workingDirectory,
      appPlan: validStartPlan(workingDirectory),
    });
    const connector = await startConnectorRuntime({
      providerKind: "codex",
      webhookPort: await unusedLoopbackPort(),
      webhookToken: K02_TOKEN,
      workingDirectory,
      policy: "read-only",
      gatewayEndpoint: gateway.endpoint,
      stateDirectory,
      provider: initial.adapter as unknown as ProviderPort,
      ...(vector.failStateAfter === undefined
        ? { crashForRecoveryState: vector.crashForRecoveryState }
        : { failStateAfter: vector.failStateAfter }),
    });
    t.after(async () => await connector.close());
    const message = k02Message(
      `cx02_x06_${vector.name.replaceAll(" ", "_")}`,
      `cx02_x06_conversation_${vector.name.replaceAll(" ", "_")}`,
    );
    gateway.enqueueMessage(message);
    assert.equal((await gateway.sendWake(connector.webhookUrl, message.id)).status, 202);
    await assert.rejects(
      connector.waitForIdle(),
      vector.failStateAfter === undefined
        ? /connector_test_crash/u
        : /connector_state_unavailable/u,
    );
    await connector.crash();
    assert.equal(
      initial.fake.launches.at(-1)?.requests.filter((request) => request.method === "thread/start")
        .length,
      1,
      vector.name,
    );
    assert.equal(
      initial.fake.launches.at(-1)?.requests.filter((request) => request.method === "turn/start")
        .length,
      0,
      vector.name,
    );

    const restarted = await createCx02Adapter(t, "CX02-CX03:X06", {
      workingDirectory,
      appPlan: { kind: "app-server", exchanges: [] },
    });
    const restartedConnector = await startConnectorRuntime({
      providerKind: "codex",
      webhookPort: await unusedLoopbackPort(),
      webhookToken: K02_TOKEN,
      workingDirectory,
      policy: "read-only",
      gatewayEndpoint: gateway.endpoint,
      stateDirectory,
      provider: restarted.adapter as unknown as ProviderPort,
    });
    t.after(async () => await restartedConnector.close());
    await restartedConnector.waitForIdle();
    assert.equal(
      restarted.fake.launches.filter((launch) => launch.mode === "app-server").length,
      0,
      vector.name,
    );
    assert.equal(gateway.tombstone(message.id)?.outcome, "uncertain", vector.name);
  }
});

test("CX02-X07 resumes only the stored thread and rejects missing mismatched or broader responses", async (t) => {
  const cwd = process.cwd();
  const invalidResponses: readonly unknown[] = [
    {},
    threadSettingsResponse(cwd, "different_thread"),
    { ...threadSettingsResponse(cwd), cwd: `${cwd}/different` },
    { ...threadSettingsResponse(cwd), approvalPolicy: "on-request" },
    { ...threadSettingsResponse(cwd), approvalsReviewer: "auto_review" },
    { ...threadSettingsResponse(cwd), sandbox: { type: "workspaceWrite", writableRoots: [cwd] } },
  ];
  for (const vector of [
    { response: threadSettingsResponse(cwd), valid: true },
    ...invalidResponses.map((response) => ({ response, valid: false })),
  ]) {
    const { response, valid } = vector;
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/resume",
          expectRequest: threadResumeRequest(cwd),
          result: response,
        },
        ...(valid
          ? [
              {
                expectMethod: "turn/start",
                result: { turn: validTurn() },
                afterResponse: [
                  { kind: "json" as const, value: turnStarted() },
                  { kind: "json" as const, value: terminalReply() },
                ],
              },
            ]
          : []),
      ],
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X07", { appPlan: plan });
    const events = await collectEvents(adapter.resume(resumeRequest()));
    if (valid) {
      assert.equal(eventName(events.at(-1)), "reply");
    } else {
      assert.equal(eventName(events.at(-1)), "failed");
    }
    assert.equal(
      fake.launches.at(-1)?.requests.filter((request) => request.method === "thread/start").length,
      0,
    );
  }
});

test("CX02-X08a sends only exact coarse thread and turn authority under both policies", async (t) => {
  const cwd = process.cwd();
  for (const policy of ["read-only", "workspace-write"] as const) {
    const text = `remote asks --model=x --sandbox=dangerFullAccess policy=${policy} skill:$evil`;
    const fake = await startFakeCodexAppServer(t, [
      { kind: "version", stdout: "codex-cli 0.149.0\n" },
      validStartPlan(cwd, { text, policy }),
    ]);
    const before = await fake.readConfigSentinel();
    const module = await import("./support/codex-app-server/cx03-production.js").then(
      async ({ loadCx03Production }) => await loadCx03Production("CX02-CX03:X08a"),
    );
    const adapter = await module.createCodexAppServerAdapterForTest({
      workingDirectory: cwd,
      policy,
      inheritedEnvironment: syntheticCx02Environment(`policy-${policy}`),
      webhookTokenEnvironmentName: "CX02_WEBHOOK_TOKEN",
      connectorPackageVersion: "0.0.0-private",
      fixtureExecutablePath: fake.executablePath,
    });
    t.after(async () => await adapter.close());
    await collectEvents(adapter.start(startRequest(text)));
    const requests = fake.launches.at(-1)?.requests ?? [];
    assert.deepEqual(requests, [
      initializeRequest(),
      { method: "initialized" },
      threadStartRequest(cwd),
      turnStartRequest(cwd, text, policy),
    ]);
    const settingsOnly = structuredClone(requests) as Record<string, unknown>[];
    const turn = settingsOnly.find((request) => request.method === "turn/start");
    assert.ok(turn !== undefined && typeof turn.params === "object" && turn.params !== null);
    const params = turn.params as { input?: { text?: string }[] };
    assert.equal(params.input?.length, 1);
    assert.equal(params.input?.[0]?.text, text);
    if (params.input?.[0] !== undefined) params.input[0].text = "<input_text>";
    const serialized = JSON.stringify(settingsOnly);
    for (const forbidden of [
      "dangerFullAccess",
      '"model"',
      "baseInstructions",
      "developerInstructions",
      '"config"',
      "dynamicTools",
      "skills",
      "apps",
      "mcpServers",
    ]) {
      assert.ok(!serialized.includes(forbidden));
    }
    assert.deepEqual(await fake.readConfigSentinel(), before);
  }
});

test("CX02-X08b validates every observable thread response without inventing turn sandbox evidence", async (t) => {
  const cwd = process.cwd();
  const exact = threadSettingsResponse(cwd);
  const variants = [
    exact,
    {},
    { ...exact, thread: validThread(cwd, "wrong_thread") },
    { ...exact, cwd: `${cwd}/other` },
    { ...exact, approvalPolicy: "on-request" },
    { ...exact, approvalsReviewer: "guardian_subagent" },
    { ...exact, sandbox: { type: "dangerFullAccess" } },
    { ...exact, unknown: true },
  ];
  for (const response of variants) {
    const valid = response === exact;
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/start",
          result: response,
          afterResponse: [{ kind: "json", value: threadStarted(cwd) }],
        },
        ...(valid
          ? [
              {
                expectMethod: "turn/start",
                result: { turn: validTurn() },
                afterResponse: [
                  { kind: "json" as const, value: turnStarted() },
                  { kind: "json" as const, value: terminalReply() },
                ],
              },
            ]
          : []),
      ],
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X08b", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), valid ? "reply" : "failed");
  }

  for (const response of variants) {
    const valid = response === exact;
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        { expectMethod: "thread/resume", result: response },
        ...(valid
          ? [
              {
                expectMethod: "turn/start",
                result: { turn: validTurn() },
                afterResponse: [
                  { kind: "json" as const, value: turnStarted() },
                  { kind: "json" as const, value: terminalReply() },
                ],
              },
            ]
          : []),
      ],
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X08b", {
      appPlan: plan,
    });
    const events = await collectEvents(adapter.resume(resumeRequest()));
    assert.equal(eventName(events.at(-1)), valid ? "reply" : "failed");
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "thread/start"),
      false,
    );
  }

  const turnResponses: readonly { name: string; result: unknown; valid: boolean }[] = [
    { name: "exact turn", result: { turn: validTurn() }, valid: true },
    { name: "missing turn", result: {}, valid: false },
    { name: "malformed turn", result: { turn: "bad" }, valid: false },
    { name: "wrong turn ID", result: { turn: validTurn("different_turn") }, valid: false },
    {
      name: "unknown turn response field",
      result: { turn: validTurn(), unknown: true },
      valid: false,
    },
  ];
  for (const vector of turnResponses) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/start",
          result: exact,
          afterResponse: [{ kind: "json", value: threadStarted(cwd) }],
        },
        {
          expectMethod: "turn/start",
          result: vector.result,
          ...(vector.valid
            ? {
                afterResponse: [
                  { kind: "json" as const, value: turnStarted() },
                  { kind: "json" as const, value: terminalReply() },
                ],
              }
            : { exitCodeAfter: 0 }),
        },
      ],
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X08b", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), vector.valid ? "reply" : "uncertain", vector.name);
  }
});
