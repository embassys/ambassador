import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AcpSessionRecord } from "../src/acp-session-store.js";
import {
  EncryptedFileLocalControlSecretStore,
  LocalControlClient,
  LocalControlClientError,
  LocalSessionControlError,
} from "../src/local-control.js";
import { LocalMcpServer } from "../src/local-mcp.js";

const SECRET = "0123456789abcdef".repeat(4);
const SESSION: AcpSessionRecord = {
  session_id: "session-control",
  agent_kind: "codex",
  working_directory: "/work",
  status: "retired",
  created_at_ms: 1,
  last_used_at_ms: 2,
  retired_at_ms: 2,
};

const router = {
  async listTools() {
    return [];
  },
  async callTool() {
    return {};
  },
};

test("serves authenticated bounded session control without weakening MCP", async (t) => {
  const calls: Array<{ id: string; verbose: boolean }> = [];
  const server = new LocalMcpServer(router, {
    port: 0,
    control: {
      secret: SECRET,
      sessions: {
        list: () => [SESSION],
        async show(sessionId, verbose) {
          if (sessionId === "missing") throw new LocalSessionControlError("session_not_found");
          calls.push({ id: sessionId, verbose });
          return verbose ? ['{"sessionUpdate":"tool_call"}'] : ["agent: answer"];
        },
      },
    },
  });
  await server.listen();
  t.after(() => server.close());

  const client = new LocalControlClient(server.endpoint, SECRET);
  assert.deepEqual(await client.listSessions(), [SESSION]);
  assert.deepEqual(await client.showSession("session-control", false), ["agent: answer"]);
  assert.deepEqual(await client.showSession("session-control", true), [
    '{"sessionUpdate":"tool_call"}',
  ]);
  assert.deepEqual(calls, [
    { id: "session-control", verbose: false },
    { id: "session-control", verbose: true },
  ]);
  await assert.rejects(
    client.showSession("missing", false),
    (error: unknown) =>
      error instanceof LocalControlClientError && error.code === "session_not_found",
  );

  await assert.rejects(
    new LocalControlClient(server.endpoint, "f".repeat(64)).listSessions(),
    (error: unknown) => error instanceof LocalControlClientError && error.code === "unauthorized",
  );
  const controlUrl = new URL("/_ambassador/control", server.endpoint);
  const browserRequest = await fetch(controlUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      origin: "http://127.0.0.1:1",
    },
    body: JSON.stringify({ operation: "sessions.list" }),
  });
  assert.equal(browserRequest.status, 403);

  const mcpWithControlToken = await fetch(server.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(mcpWithControlToken.status, 400);
});

test("encrypts the internal control secret and keeps it stable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-control-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "control-secret.json");
  const keyPath = join(root, "control-secret.key");
  const first = new EncryptedFileLocalControlSecretStore(path, keyPath);
  const created = await first.createOrLoad();
  assert.match(created, /^[a-f0-9]{64}$/u);
  assert.equal(await first.createOrLoad(), created);
  const second = new EncryptedFileLocalControlSecretStore(path, keyPath);
  assert.equal(await second.load(), created);
  assert.equal((await readFile(path)).includes(Buffer.from(created)), false);
});

test("stops only the authenticated process instance named by the caller", async (t) => {
  let stops = 0;
  const server = new LocalMcpServer(router, {
    port: 0,
    control: {
      secret: SECRET,
      sessions: { list: () => [], show: () => [] },
      stop: () => {
        stops += 1;
      },
    },
  });
  await server.listen();
  t.after(() => server.close());
  const client = new LocalControlClient(server.endpoint, SECRET);
  const instanceId = await client.getProcessInstance();
  assert.match(instanceId, /^[0-9a-f-]{36}$/u);
  await assert.rejects(client.stopProcess("00000000-0000-4000-8000-000000000000"));
  await assert.rejects(
    new LocalControlClient(server.endpoint, "f".repeat(64)).stopProcess(instanceId),
  );
  const url = new URL("/_ambassador/control", server.endpoint);
  for (const invalid of [
    { origin: "http://127.0.0.1:1", body: { operation: "process.stop", instance_id: instanceId } },
    { body: { operation: "process.stop", instance_id: instanceId, force: true } },
    { body: { operation: "process.stop" } },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        ...("origin" in invalid ? { origin: invalid.origin } : {}),
      },
      body: JSON.stringify(invalid.body),
    });
    assert.equal(response.ok, false);
    await response.body?.cancel();
  }
  assert.equal(stops, 0);
  await client.stopProcess(instanceId);
  assert.equal(stops, 1);
  await client.stopProcess(instanceId);
  assert.equal(stops, 1);
});
