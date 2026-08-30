import assert from "node:assert/strict";
import { appendFile, chmod } from "node:fs/promises";
import test from "node:test";
import {
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
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";
import { ManualK02Clock } from "./support/connector/k02-production.js";

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
    inheritedEnvironment: process.env,
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
    HOME: "/cx02/home",
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    CX02_WEBHOOK_TOKEN: "a".repeat(48),
    OPENAI_API_KEY: "forbidden-api-key",
    NODE_OPTIONS: "--import=forbidden",
    A2A_REMOTE_COMMAND: "forbidden",
  };
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X02", {
    appPlan: validStartPlan(cwd),
    inheritedEnvironment: inherited,
  });
  await collectEvents(adapter.start(startRequest()));
  const app = fake.launches.find((launch) => launch.mode === "app-server");
  assert.ok(app !== undefined);
  assert.deepEqual(app.arguments, ["app-server", "--listen", "stdio://", "--strict-config"]);
  assert.equal(app.cwd, cwd);
  assert.equal(app.environment.CX02_WEBHOOK_TOKEN, undefined);
  assert.equal(app.environment.OPENAI_API_KEY, undefined);
  assert.equal(app.environment.NODE_OPTIONS, undefined);
  assert.equal(app.environment.A2A_REMOTE_COMMAND, undefined);
  assert.ok(!JSON.stringify(app).includes("CX02 untrusted input"));
  assert.ok(Object.keys(app.environment).every((name) => Object.hasOwn(inherited, name)));
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
      exchanges: [
        ...handshakeExchanges(),
        {
          expectMethod: "thread/start",
          beforeResponse: [{ kind: "json", value: configWarning }],
        },
      ],
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
        : variant.exchanges,
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X04", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    if (variant.valid) assert.equal(eventName(events.at(-1)), "reply", variant.name);
    else
      assert.deepEqual(events, [
        { event: "failed", execution_id: CX02_EXECUTION_ID, reason_code: "provider_start_failed" },
      ]);
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
      inheritedEnvironment: process.env,
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
    const serialized = JSON.stringify(requests);
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
    assert.ok(!JSON.stringify(response).includes("effectiveTurnSandbox"));
  }
});
