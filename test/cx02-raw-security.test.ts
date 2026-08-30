import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CX02_THREAD_ID,
  CX02_TURN_ID,
  collectEvents,
  createCx02Adapter,
  type FakeCodexExchange,
  type FakeCodexProcessPlan,
  type FakeCodexWireWrite,
  handshakeExchanges,
  resumeRequest,
  startRequest,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

function started(cwd: string): FakeCodexExchange[] {
  return [
    ...handshakeExchanges(),
    {
      expectMethod: "thread/start",
      result: threadSettingsResponse(cwd),
      afterResponse: [
        { kind: "json", value: { method: "thread/started", params: { thread: validThread(cwd) } } },
      ],
    },
  ];
}

function completed(text = "raw-boundary reply"): unknown {
  return {
    method: "turn/completed",
    params: {
      threadId: CX02_THREAD_ID,
      turn: validTurn(CX02_TURN_ID, "completed", [
        { id: "raw_item", type: "agentMessage", phase: "final_answer", text },
      ]),
    },
  };
}

function activePlan(
  cwd: string,
  writes: readonly FakeCodexWireWrite[],
  stderrBytes?: number,
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  return {
    kind: "app-server",
    exchanges: [
      ...started(cwd),
      {
        expectMethod: "turn/start",
        result: { turn: validTurn() },
        afterResponse: [
          {
            kind: "json",
            value: {
              method: "turn/started",
              params: { threadId: CX02_THREAD_ID, turn: validTurn() },
            },
          },
          ...writes,
        ],
      },
    ],
    ...(stderrBytes === undefined ? {} : { stderrBytes }),
  };
}

function jsonLineBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`);
}

function stdoutBoundaryPlan(
  cwd: string,
  targetBytes: number,
): Extract<FakeCodexProcessPlan, { kind: "app-server" }> {
  const threadResult = threadSettingsResponse(cwd);
  const threadNotification = {
    method: "thread/started",
    params: { thread: validThread(cwd) },
  };
  const turnResult = { turn: validTurn() };
  const turnNotification = {
    method: "turn/started",
    params: { threadId: CX02_THREAD_ID, turn: validTurn() },
  };
  const terminal = completed("stdout-boundary reply");
  const fixedBytes = [
    { id: 1, result: {} },
    { id: 2, result: threadResult },
    threadNotification,
    { id: 3, result: turnResult },
    turnNotification,
    terminal,
  ].reduce<number>((total, value) => total + jsonLineBytes(value), 0);
  const emptyWarning = { method: "warning", params: { message: "" } };
  const emptyWarningBytes = jsonLineBytes(emptyWarning);
  let remaining = targetBytes - fixedBytes;
  const warnings: FakeCodexWireWrite[] = [];
  while (remaining > 0) {
    const lineBytes = Math.min(1_000_000, remaining);
    assert.ok(lineBytes >= emptyWarningBytes);
    warnings.push({
      kind: "json",
      value: {
        method: "warning",
        params: { message: "x".repeat(lineBytes - emptyWarningBytes) },
      },
    });
    remaining -= lineBytes;
  }
  return {
    kind: "app-server",
    exchanges: [
      ...handshakeExchanges(),
      {
        expectMethod: "thread/start",
        result: threadResult,
        afterResponse: [{ kind: "json", value: threadNotification }],
      },
      {
        expectMethod: "turn/start",
        result: turnResult,
        afterResponse: [
          { kind: "json", value: turnNotification },
          ...warnings,
          { kind: "json", value: terminal },
        ],
      },
    ],
  };
}

function utf8Write(value: string): FakeCodexWireWrite {
  return { kind: "utf8", value };
}

function jsonRecordAtBytes(method: string, targetBytes: number, depth = 1): string {
  let nested: unknown = "";
  for (let index = 2; index < depth; index += 1) nested = [nested];
  const base = {
    method,
    params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID, nested, pad: "" },
  };
  const empty = JSON.stringify(base);
  const padding = targetBytes - Buffer.byteLength(empty);
  assert.ok(padding >= 0);
  return `${JSON.stringify({ ...base, params: { ...base.params, pad: "x".repeat(padding) } })}\n`;
}

async function runCommand(executable: string, arguments_: readonly string[]): Promise<void> {
  const child = spawn(executable, [...arguments_], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error("CX02 artifact command failed"));
    });
  });
}

test("CX02-X20 enforces UTF-8 JSONL record byte and depth boundaries before normalization", async (t) => {
  const cwd = process.cwd();
  const exactRecord = jsonRecordAtBytes("turn/diff/updated", 1_048_576);
  assert.equal(Buffer.byteLength(exactRecord) - 1, 1_048_576);
  const depth100 = jsonRecordAtBytes("turn/diff/updated", 1_024, 100);
  const cases: readonly {
    name: string;
    writes: readonly FakeCodexWireWrite[];
    accepted: boolean;
  }[] = [
    {
      name: "exact record",
      writes: [utf8Write(exactRecord), { kind: "json", value: completed() }],
      accepted: true,
    },
    {
      name: "one-over record",
      writes: [utf8Write(jsonRecordAtBytes("turn/diff/updated", 1_048_577))],
      accepted: false,
    },
    {
      name: "depth 100",
      writes: [utf8Write(depth100), { kind: "json", value: completed() }],
      accepted: true,
    },
    {
      name: "depth 101",
      writes: [utf8Write(jsonRecordAtBytes("turn/diff/updated", 1_024, 101))],
      accepted: false,
    },
    {
      name: "invalid UTF-8",
      writes: [{ kind: "base64", value: Buffer.from([0xc3, 0x28, 0x0a]).toString("base64") }],
      accepted: false,
    },
    {
      name: "duplicate key",
      writes: [utf8Write('{"method":"warning","method":"warning","params":{"message":"x"}}\n')],
      accepted: false,
    },
    {
      name: "escaped-equivalent duplicate key",
      writes: [
        utf8Write('{"method":"warning","\\u006dethod":"warning","params":{"message":"x"}}\n'),
      ],
      accepted: false,
    },
    { name: "array", writes: [utf8Write("[]\n")], accepted: false },
    {
      name: "batch",
      writes: [utf8Write('[{"method":"warning","params":{"message":"x"}}]\n')],
      accepted: false,
    },
    {
      name: "unknown method",
      writes: [utf8Write('{"method":"future/unknown","params":{}}\n')],
      accepted: false,
    },
    {
      name: "unknown control field",
      writes: [
        utf8Write('{"method":"turn/started","params":{"threadId":"x","turn":{}},"extra":true}\n'),
      ],
      accepted: false,
    },
    {
      name: "unterminated line",
      writes: [utf8Write('{"method":"warning","params":{"message":"x"}}')],
      accepted: false,
    },
  ];
  for (const vector of cases) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X20", {
      appPlan: activePlan(cwd, vector.writes),
    });
    const terminal = (await collectEvents(adapter.start(startRequest()))).at(-1);
    assert.equal(eventName(terminal), vector.accepted ? "reply" : "uncertain", vector.name);
  }
});

test("CX02-X21 preserves every common exact limit through valid App Server envelopes", async (t) => {
  const cwd = process.cwd();
  const delta = (text: string, itemId = "limit_item") => ({
    method: "item/agentMessage/delta",
    params: { threadId: CX02_THREAD_ID, turnId: CX02_TURN_ID, itemId, delta: text },
  });
  const matrices: readonly {
    name: string;
    writes: readonly FakeCodexWireWrite[];
    accepted: boolean;
    stderrBytes?: number;
  }[] = [
    {
      name: "10000 normalized events",
      writes: [
        ...Array.from({ length: 9_997 }, () => ({ kind: "json" as const, value: delta("x") })),
        { kind: "json", value: completed("reply") },
      ],
      accepted: true,
    },
    {
      name: "10001 normalized events",
      writes: Array.from({ length: 9_999 }, () => ({ kind: "json" as const, value: delta("x") })),
      accepted: false,
    },
    {
      name: "progress exact",
      writes: [
        { kind: "json", value: delta("x".repeat(262_144)) },
        { kind: "json", value: completed() },
      ],
      accepted: true,
    },
    {
      name: "progress one over",
      writes: [{ kind: "json", value: delta("x".repeat(262_145)) }],
      accepted: false,
    },
    {
      name: "reply exact",
      writes: [{ kind: "json", value: completed("x".repeat(262_144)) }],
      accepted: true,
    },
    {
      name: "reply one over",
      writes: [{ kind: "json", value: completed("x".repeat(262_145)) }],
      accepted: false,
    },
    {
      name: "turn ID exact",
      writes: [{ kind: "json", value: completed("reply") }],
      accepted: true,
    },
    {
      name: "stderr exact",
      writes: [{ kind: "json", value: completed() }],
      stderrBytes: 8_388_608,
      accepted: true,
    },
    { name: "stderr one over", writes: [], stderrBytes: 8_388_609, accepted: false },
  ];
  for (const vector of matrices) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: activePlan(cwd, vector.writes, vector.stderrBytes),
    });
    const terminal = (await collectEvents(adapter.start(startRequest()))).at(-1);
    assert.equal(eventName(terminal), vector.accepted ? "reply" : "uncertain", vector.name);
  }

  for (const bytes of [1_024, 1_025]) {
    const turnId = "x".repeat(bytes);
    const base = activePlan(cwd, [{ kind: "json", value: completed() }]);
    const replacement: FakeCodexExchange = {
      expectMethod: "turn/start",
      result: { turn: validTurn(turnId) },
      afterResponse: [
        {
          kind: "json",
          value: {
            method: "turn/started",
            params: { threadId: CX02_THREAD_ID, turn: validTurn(turnId) },
          },
        },
        {
          kind: "json",
          value: {
            method: "turn/completed",
            params: {
              threadId: CX02_THREAD_ID,
              turn: validTurn(turnId, "completed", [
                { id: "i", type: "agentMessage", phase: "final_answer", text: "reply" },
              ]),
            },
          },
        },
      ],
    };
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      ...base,
      exchanges: base.exchanges.map((exchange, index) => (index === 3 ? replacement : exchange)),
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", { appPlan: plan });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), bytes === 1_024 ? "reply" : "uncertain");
  }

  for (const bytes of [1_024, 1_025]) {
    const threadId = "s".repeat(bytes);
    const plan = activePlan(cwd, [{ kind: "json", value: completed("reply") }]);
    const threadExchange: FakeCodexExchange = {
      expectMethod: "thread/start",
      result: threadSettingsResponse(cwd, threadId),
      afterResponse: [
        {
          kind: "json",
          value: { method: "thread/started", params: { thread: validThread(cwd, threadId) } },
        },
      ],
    };
    const turnExchange: FakeCodexExchange = {
      expectMethod: "turn/start",
      result: { turn: validTurn() },
      afterResponse: [
        {
          kind: "json",
          value: { method: "turn/started", params: { threadId, turn: validTurn() } },
        },
        {
          kind: "json",
          value: {
            method: "turn/completed",
            params: {
              threadId,
              turn: validTurn(CX02_TURN_ID, "completed", [
                { id: "i", type: "agentMessage", phase: "final_answer", text: "reply" },
              ]),
            },
          },
        },
      ],
    };
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: {
        ...plan,
        exchanges: [...handshakeExchanges(), threadExchange, turnExchange],
      },
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), bytes === 1_024 ? "reply" : "uncertain");
  }

  for (const bytes of [1_024, 1_025]) {
    const approvalRequestId = `approval/${"a".repeat(bytes - 11)}`;
    assert.equal(Buffer.byteLength(`s:${approvalRequestId}`), bytes);
    const plan = activePlan(cwd, [
      {
        kind: "json",
        value: {
          id: approvalRequestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: CX02_THREAD_ID,
            turnId: CX02_TURN_ID,
            itemId: "approval_item",
            reason: "content must not cross the provider port",
          },
        },
      },
    ]);
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", { appPlan: plan });
    const iterator = adapter.start(startRequest())[Symbol.asyncIterator]();
    assert.equal(eventName((await iterator.next()).value), "session_bound");
    assert.equal(eventName((await iterator.next()).value), "turn_bound");
    const next = await iterator.next();
    if (bytes === 1_024) {
      assert.equal(eventName(next.value), "approval_required");
      assert.equal(
        (next.value as { approval_request_id?: unknown }).approval_request_id,
        `s:${approvalRequestId}`,
      );
    } else {
      assert.equal(eventName(next.value), "uncertain");
    }
    await iterator.return?.();
  }

  for (const bytes of [8_388_608, 8_388_609]) {
    const { adapter } = await createCx02Adapter(t, "CX02-CX03:X21", {
      appPlan: stdoutBoundaryPlan(cwd, bytes),
    });
    const events = await collectEvents(adapter.start(startRequest()));
    assert.equal(eventName(events.at(-1)), bytes === 8_388_608 ? "reply" : "uncertain");
  }
});

test("CX02-X22 never replaces a missing mutated or unavailable stored thread", async (t) => {
  const cwd = process.cwd();
  const responses = [
    {},
    { thread: validThread(cwd, "different_thread") },
    { ...threadSettingsResponse(cwd), thread: { ...validThread(cwd), turns: [] } },
    { ...threadSettingsResponse(cwd), cwd: `${cwd}/moved` },
  ];
  for (const result of responses) {
    const plan: Extract<FakeCodexProcessPlan, { kind: "app-server" }> = {
      kind: "app-server",
      exchanges: [...handshakeExchanges(), { expectMethod: "thread/resume", result }],
    };
    const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X22", { appPlan: plan });
    const events = await collectEvents(adapter.resume(resumeRequest()));
    assert.ok(["failed", "uncertain"].includes(String(eventName(events.at(-1)))));
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "thread/start"),
      false,
    );
    assert.equal(
      fake.launches.at(-1)?.requests.some((request) => request.method === "turn/start"),
      false,
    );
  }
});

test("CX02-X23 excludes content auth schemas and test controls from state and staged packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx02-leakage-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd, { mode: 0o700 });
  const markers = [
    "CX02_A2A_TEXT_SECRET",
    "CX02_REPLY_SECRET",
    "CX02_TOOL_DETAIL_SECRET",
    "CX02_APPROVAL_SECRET",
    "CX02_CODEX_AUTH_SECRET",
  ];
  const { fake, adapter } = await createCx02Adapter(t, "CX02-CX03:X23", {
    workingDirectory: cwd,
    inheritedEnvironment: {
      HOME: "/cx02/provider-home",
      PATH: process.env.PATH,
      OPENAI_API_KEY: markers[4],
      CX02_WEBHOOK_TOKEN: "a".repeat(48),
    },
    appPlan: activePlan(cwd, [{ kind: "json", value: completed(markers[1]) }]),
  });
  await collectEvents(adapter.start(startRequest(markers[0])));
  const launch = fake.launches.at(-1);
  assert.ok(launch !== undefined);
  const executionSurface = JSON.stringify({
    arguments: launch.arguments,
    environment: launch.environment,
  });
  for (const marker of markers) assert.ok(!executionSurface.includes(marker));
  const runtimeEntries = await readdir(root, { recursive: true });
  for (const entry of runtimeEntries) {
    const path = join(root, String(entry));
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      continue;
    }
    for (const marker of markers) assert.ok(!body.includes(Buffer.from(marker)));
  }

  for (const provider of ["codex"] as const) {
    await runCommand(process.execPath, [join("scripts", "build-connector.mjs"), provider]);
    await runCommand(process.execPath, [join("scripts", "stage-connector.mjs"), provider]);
    await runCommand(process.execPath, [join("scripts", "check-packed-connector.mjs"), provider]);
  }
  const stagedRoot = ".stage/connectors/codex/package";
  const entries = await readdir(stagedRoot, { recursive: true });
  assert.ok(entries.every((entry) => !String(entry).includes("schemas.json")));
  assert.ok(entries.every((entry) => !String(entry).includes("fixture")));
  for (const entry of entries) {
    const path = join(stagedRoot, String(entry));
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      continue;
    }
    const serialized = body.toString("utf8");
    for (const marker of markers) assert.ok(!serialized.includes(marker));
    for (const control of [
      "ForTest",
      "fixtureExecutablePath",
      "afterVersionProbeForTest",
      "codex-app-server/0.149.0",
    ]) {
      assert.ok(!serialized.includes(control));
    }
  }
  const schema = await readFile(
    "test/fixtures/codex-app-server/0.149.0/codex_app_server_protocol.v2.schemas.json",
  );
  assert.equal(
    createHash("sha256").update(schema).digest("hex"),
    "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9",
  );
});
