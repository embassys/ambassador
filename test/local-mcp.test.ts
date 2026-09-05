import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { type LocalMcpRouter, LocalMcpServer, LocalMcpToolError } from "../src/local-mcp.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";
import { rawPost } from "./support/raw-http.js";

const MAX_TOOL_RESULT_BYTES = 768 * 1024;

test("modern stateless requests use the SDK envelope and return the exact client context", async (t) => {
  const backend = router();
  backend.callTool = async (_name, _arguments, _signal, client) => ({ client: client?.name });
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const response = await fetch(server.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "echo",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "codex-mcp-client", version: "fixture" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.match(body, /codex-mcp-client/u);
});

test("held message_box calls stream POST keepalives and leave ordinary tools available", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = router();
  backend.callTool = async (name, _input, signal) => {
    if (name === "message_box") {
      await Promise.race([
        held,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        ),
      ]);
    }
    return { status: "completed" };
  };
  backend.listTools = async () => [
    { name: "message_box", inputSchema: { type: "object" } },
    { name: "echo", inputSchema: { type: "object" } },
  ];
  const server = new LocalMcpServer(backend, { port: 0, requestTimeoutMs: 50, keepAliveMs: 5 });
  await server.listen();
  t.after(() => server.close());
  t.after(() => release());
  const client = new Client({ name: "wait-fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.endpoint));
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.title, "Embassys Ambassador");
  t.after(() => client.close());
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": transport.sessionId as string,
    "mcp-protocol-version": "2025-06-18",
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(server.endpoint, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "message_box",
        arguments: { type: "check", request_id: "00000000-0000-4000-8000-000000000001" },
      },
    }),
  });
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.match(new TextDecoder().decode((await reader.read()).value), /keepalive/u);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.match(JSON.stringify(await client.callTool({ name: "echo" })), /completed/u);
  release();
  let body = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    body += new TextDecoder().decode(part.value);
  }
  assert.match(body, /completed/u);
});

test("held waits send requested MCP progress and stop it on completion or cancellation", async (t) => {
  const backend = router();
  backend.callTool = async (_name, input, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, input.cancel ? 2_000 : 120);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
    return { status: "pending" };
  };
  const server = new LocalMcpServer(backend, { port: 0, keepAliveMs: 10 });
  await server.listen();
  t.after(() => server.close());
  const client = new Client({ name: "progress-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
  t.after(() => client.close());
  const progress: number[] = [];
  await client.callTool(
    { name: "message_box", arguments: { type: "check" } },
    {
      timeout: 1_000,
      onprogress: (update) => {
        progress.push(update.progress);
      },
    },
  );
  assert.ok(progress.length >= 2, "SSE comments alone do not prevent client idle timeouts");
  assert.ok(progress.every((value, i) => i === 0 || value > (progress[i - 1] ?? 0)));
  const count = progress.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(progress.length, count);

  const abort = new AbortController();
  let cancelledProgress = 0;
  await assert.rejects(
    client.callTool(
      { name: "message_box", arguments: { type: "check", cancel: true } },
      {
        signal: abort.signal,
        timeout: 1_000,
        onprogress: () => {
          if (++cancelledProgress === 2) abort.abort();
        },
      },
    ),
  );
  assert.equal(cancelledProgress, 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cancelledProgress, 2);
});

test("reclaims sessions after repeated normal SDK client closes", {
  timeout: 30_000,
}, async (t) => {
  const server = new LocalMcpServer(router(), { port: 0 });
  await server.listen();
  t.after(() => server.close());
  for (let i = 0; i < 1_000; i += 1) {
    const client = new Client({ name: "ambassador-churn-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
      assert.equal((await client.listTools()).tools[0]?.name, "echo");
    } finally {
      await client.close();
    }
  }
});

test("capacity reclamation preserves an in-flight tool and its client metadata", async (t) => {
  const backend = router();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.callTool = async (_name, _arguments, _signal, clientInfo) => {
    entered();
    await blocked;
    return { client: clientInfo?.name };
  };
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  t.after(() => release());
  const active = new TestMcpClient(server.endpoint);
  await active.initialize({ name: "active-owner", version: "1" });
  const result = active.callTool("echo", { value: "held" });
  await started;
  for (let i = 0; i < 40; i += 1) {
    const client = new TestMcpClient(server.endpoint);
    await client.initialize();
  }
  release();
  assert.deepEqual(await result, { client: "active-owner" });
  assert.equal((await active.listTools())[0]?.name, "echo");
});

test("expires inactive sessions and accepts a new initialization", async (t) => {
  let now = 0;
  const server = new LocalMcpServer(router(), { port: 0, nowMs: () => now });
  await server.listen();
  t.after(() => server.close());
  const stale = new TestMcpClient(server.endpoint);
  await stale.initialize();
  now = 30 * 60 * 1_000;
  await assert.rejects(stale.listTools(), /404/u);
  const fresh = new TestMcpClient(server.endpoint);
  await fresh.initialize();
  assert.equal((await fresh.listTools())[0]?.name, "echo");
});

test("reclaims clients that disconnect while a large tool response is being written", {
  timeout: 15_000,
}, async (t) => {
  const backend = router();
  backend.callTool = async () => ({ echoed: "x".repeat(700 * 1024) });
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  for (let i = 0; i < 40; i += 1) {
    const client = new Client({ name: "abrupt-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint));
    try {
      await client.connect(transport);
      const controller = new AbortController();
      const response = await fetch(server.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId as string,
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "tools/call",
          params: { name: "echo", arguments: { value: "large" } },
        }),
      });
      assert.equal(response.status, 200);
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    } finally {
      await client.close();
    }
  }
});

function router(): LocalMcpRouter & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async listTools() {
      return [
        {
          name: "echo",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ];
    },
    async callTool(name, arguments_, _signal, clientInfo) {
      calls.push({ name, arguments: arguments_, clientInfo });
      return { echoed: arguments_.value };
    },
  };
}

test("serves a loopback-only stateful MCP tool without bearer setup", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());

  const client = new TestMcpClient(server.endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.deepEqual(client.serverCapabilities.tools, {});
  assert.match(client.serverInstructions ?? "", /call register_agent immediately/iu);
  assert.match(client.serverInstructions ?? "", /Embassys/iu);
  assert.match(client.serverInstructions ?? "", /acknowledge its receipt/iu);
  assert.match(client.serverInstructions ?? "", /ask_owner.*exact call_id/u);
  assert.match(client.serverInstructions ?? "", /exact labels and values/u);
  assert.match(client.serverInstructions ?? "", /permission grant alone does not authorize/u);
  assert.match(client.serverInstructions ?? "", /new UUID request_id/u);
  assert.match(client.serverInstructions ?? "", /approval decision is not.*requested data/u);
  assert.match(client.serverInstructions ?? "", /check actual availability before proposing/u);
  assert.match(client.serverInstructions ?? "", /include that email as an attendee/u);
  assert.match(client.serverInstructions ?? "", /target_email selects the other agent/u);
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["echo"],
  );
  assert.deepEqual(await client.callTool("echo", { value: "safe value" }), {
    echoed: "safe value",
  });
  assert.deepEqual(backend.calls, [
    {
      name: "echo",
      arguments: { value: "safe value" },
      clientInfo: { name: "openclaw-bundle-mcp", version: "0.0.0" },
    },
  ]);

  const secondClient = new TestMcpClient(server.endpoint);
  await secondClient.initialize();
  assert.deepEqual(
    (await secondClient.listTools()).map((tool) => tool.name),
    ["echo"],
  );
});

test("returns a useful bounded message and source for expected tool errors", async (t) => {
  const backend = router();
  backend.callTool = async () => {
    throw new LocalMcpToolError("unsupported_email_format", undefined, "central_enrollment");
  };
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const client = new TestMcpClient(server.endpoint);
  await client.initialize();

  await assert.rejects(
    client.callTool("echo", { value: "person+agent@example.test" }),
    (error: unknown) => {
      assert.ok(error instanceof McpCallError);
      assert.match(error.serverMessage, /email address format/iu);
      assert.deepEqual(error.data, {
        code: "unsupported_email_format",
        source: "central_enrollment",
      });
      return true;
    },
  );
});

test("workflow errors tell the agent how to recover without repeating uncertain work", async (t) => {
  let code = "action_type_unknown";
  const backend = router();
  backend.callTool = async () => {
    throw new LocalMcpToolError(code, undefined, "message_box");
  };
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const client = new TestMcpClient(server.endpoint);
  await client.initialize();
  for (const [next, expected] of [
    ["action_type_unknown", /list_action_types/],
    ["request_id_conflict", /same request/],
    ["operation_already_pending", /existing/],
    ["invalid_action_payload", /schema/],
    ["permission_denied", /target person's human.*caller cannot approve/],
    ["owner_question_pending", /question/],
  ] as const) {
    code = next;
    await assert.rejects(client.callTool("echo", {}), (error: unknown) => {
      assert.ok(error instanceof McpCallError);
      assert.match(error.serverMessage, expected);
      return true;
    });
  }
});

test("rejects host, origin, authorization, and body violations before dispatch", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const port = new URL(server.endpoint).port;
  const marker = "body-marker-must-not-be-reflected";

  const suppliedAuthorization = await fetch(server.endpoint, {
    method: "POST",
    headers: { authorization: "Bearer should-not-be-needed", "content-type": "application/json" },
    body: marker,
  });
  assert.equal(suppliedAuthorization.status, 400);
  assert.ok(!(await suppliedAuthorization.text()).includes(marker));

  const wrongOrigin = await fetch(server.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: marker,
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongHost = await rawPost(
    server.endpoint,
    {
      "content-type": "application/json",
      host: `localhost:${port}`,
    },
    marker,
  );
  assert.equal(wrongHost.status, 421);

  const oversized = await rawPost(
    server.endpoint,
    {
      "content-type": "application/json",
      host: `127.0.0.1:${port}`,
    },
    `${marker}${"x".repeat(1024 * 1024)}`,
  );
  assert.equal(oversized.status, 413);
  assert.ok(!oversized.body.includes(marker));
  assert.equal(backend.calls.length, 0);
});

test("returns a 768 KiB tool result and rejects one byte above it before transport", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const client = new TestMcpClient(server.endpoint);
  await client.initialize();

  const emptyResultBytes = Buffer.byteLength(JSON.stringify({ echoed: "" }));
  const boundary = "x".repeat(MAX_TOOL_RESULT_BYTES - emptyResultBytes);
  assert.equal(Buffer.byteLength(JSON.stringify({ echoed: boundary })), MAX_TOOL_RESULT_BYTES);
  assert.deepEqual(await client.callTool("echo", { value: boundary }), { echoed: boundary });

  await assert.rejects(
    client.callTool("echo", { value: `${boundary}x` }),
    (error: unknown) => error instanceof McpCallError,
  );
});

test("rejects JSON-RPC batches before dispatching any tool call", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const client = new TestMcpClient(server.endpoint);
  await client.initialize();

  const response = await client.postBatch([
    {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "first" } },
    },
    {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "second" } },
    },
  ]);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Request rejected\n");
  assert.deepEqual(backend.calls, []);
});
