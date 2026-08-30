import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CODEX_FIXTURE_SCHEMA_SHA256,
  initializeRequest,
  startFakeCodexAppServer,
  syntheticCx02Environment,
  threadSettingsResponse,
  validThread,
  validTurn,
} from "./support/codex-app-server/index.js";

const SCHEMA = "test/fixtures/codex-app-server/0.149.0/codex_app_server_protocol.v2.schemas.json";
const NOTICE = "test/fixtures/codex-app-server/0.149.0/SOURCE.md";

async function completion(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("CX02 support pins the exact stable Codex 0.149.0 schema and source notice", async () => {
  const schema = await readFile(SCHEMA);
  assert.equal(createHash("sha256").update(schema).digest("hex"), CODEX_FIXTURE_SCHEMA_SHA256);
  const parsed = JSON.parse(schema.toString("utf8")) as Readonly<Record<string, unknown>>;
  assert.equal(parsed.$schema, "http://json-schema.org/draft-07/schema#");
  const notice = await readFile(NOTICE, "utf8");
  assert.match(notice, /rust-v0\.149\.0/u);
  assert.match(notice, new RegExp(CODEX_FIXTURE_SCHEMA_SHA256, "u"));
  assert.match(notice, /Apache-2\.0/u);
  assert.match(notice, /test fixture only/u);
  assert.ok(!schema.includes(Buffer.from('"experimental"', "utf8")));
});

test("CX02 support runs a full-process fake Codex handshake, session, and turn over JSONL stdio", async (t) => {
  const cwd = process.cwd();
  const threadId = "thread_fixture_1";
  const turnId = "turn_fixture_1";
  const initialized = { method: "initialized" };
  const threadStart = {
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
  const turnStart = {
    id: 3,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: "fixture input", text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  };
  const fake = await startFakeCodexAppServer(t, [
    { kind: "version", stdout: "codex-cli 0.149.0\n" },
    {
      kind: "app-server",
      exchanges: [
        {
          expectMethod: "initialize",
          result: { userAgent: "codex_cli_rs/0.149.0" },
        },
        { expectMethod: "initialized", expectRequest: initialized },
        {
          expectMethod: "thread/start",
          expectRequest: threadStart,
          beforeResponse: [
            {
              kind: "json",
              value: {
                method: "thread/started",
                params: { thread: validThread(cwd, threadId) },
              },
            },
          ],
          result: threadSettingsResponse(cwd, threadId),
        },
        {
          expectMethod: "turn/start",
          expectRequest: turnStart,
          result: { turn: validTurn(turnId) },
          afterResponse: [
            {
              kind: "json",
              value: {
                method: "turn/started",
                params: {
                  threadId,
                  turn: validTurn(turnId),
                },
              },
            },
            {
              kind: "json",
              value: {
                method: "turn/completed",
                params: {
                  threadId,
                  turn: validTurn(turnId, "completed", [
                    {
                      id: "item_fixture_1",
                      type: "agentMessage",
                      phase: "final_answer",
                      text: "fixture reply",
                    },
                  ]),
                },
              },
            },
          ],
        },
      ],
    },
  ]);

  const version = fake.spawnForFixture(["--version"], {
    cwd,
    environment: syntheticCx02Environment("fixture-version"),
  });
  let versionStdout = "";
  version.stdout.setEncoding("utf8");
  version.stdout.on("data", (chunk: string) => {
    versionStdout += chunk;
  });
  assert.deepEqual(await completion(version), { code: 0, signal: null });
  assert.equal(versionStdout, "codex-cli 0.149.0\n");

  const server = fake.spawnForFixture(["app-server", "--listen", "stdio://", "--strict-config"], {
    cwd,
    environment: syntheticCx02Environment("fixture-app-server"),
  });
  const received: Readonly<Record<string, unknown>>[] = [];
  const lines = server.stdout.setEncoding("utf8");
  let buffer = "";
  lines.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      received.push(JSON.parse(line) as Readonly<Record<string, unknown>>);
    }
  });
  const initialize = initializeRequest();
  for (const request of [initialize, initialized, threadStart, turnStart]) {
    server.stdin.write(`${JSON.stringify(request)}\n`);
  }
  await fake.waitForRequests(4);
  await new Promise<void>((resolve) => setImmediate(resolve));
  server.stdin.end();
  assert.deepEqual(await completion(server), { code: 0, signal: null });
  assert.equal(buffer, "");
  assert.equal(received.length, 6);
  assert.deepEqual(
    fake.launches.map((launch) => ({ mode: launch.mode, arguments: launch.arguments })),
    [
      { mode: "version", arguments: ["--version"] },
      {
        mode: "app-server",
        arguments: ["app-server", "--listen", "stdio://", "--strict-config"],
      },
    ],
  );
  assert.deepEqual(fake.launches[1]?.requests, [initialize, initialized, threadStart, turnStart]);
  assert.deepEqual(
    await fake.readConfigSentinel(),
    Buffer.from("CX02 provider config must stay byte-identical\n"),
  );
});
