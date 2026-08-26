import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { type LocalMcpRouter, LocalMcpServer } from "../src/local-mcp.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";
import { rawPost } from "./support/raw-http.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_TOOL_RESULT_BYTES = 512 * 1024;

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
    async callTool(name, arguments_) {
      calls.push({ name, arguments: arguments_ });
      return { echoed: arguments_.value };
    },
  };
}

test("serves an authenticated stateful MCP tool through the official transport", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(TOKEN, backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());

  const client = new TestMcpClient(server.endpoint, TOKEN);
  await client.initialize();
  assert.deepEqual(client.serverCapabilities.tools, { listChanged: true });
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["echo"],
  );
  assert.deepEqual(await client.callTool("echo", { value: "safe value" }), {
    echoed: "safe value",
  });
  assert.deepEqual(backend.calls, [{ name: "echo", arguments: { value: "safe value" } }]);

  const secondClient = new TestMcpClient(server.endpoint, TOKEN);
  await secondClient.initialize();
  assert.deepEqual(
    (await secondClient.listTools()).map((tool) => tool.name),
    ["echo"],
  );

  const listChanged = client.waitForNotification("notifications/tools/list_changed");
  await delay(20);
  await server.sendToolListChanged();
  await listChanged;
});

test("rejects host, origin, bearer, and body violations before dispatch", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(TOKEN, backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const port = new URL(server.endpoint).port;
  const marker = "body-marker-must-not-be-reflected";

  const unauthenticated = await fetch(server.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: marker,
  });
  assert.equal(unauthenticated.status, 401);
  assert.ok(!(await unauthenticated.text()).includes(marker));

  const wrongOrigin = await fetch(server.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: marker,
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongHost = await rawPost(
    server.endpoint,
    {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      host: `localhost:${port}`,
    },
    marker,
  );
  assert.equal(wrongHost.status, 421);

  const oversized = await rawPost(
    server.endpoint,
    {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      host: `127.0.0.1:${port}`,
    },
    `${marker}${"x".repeat(1024 * 1024)}`,
  );
  assert.equal(oversized.status, 413);
  assert.ok(!oversized.body.includes(marker));
  assert.equal(backend.calls.length, 0);
});

test("returns a 512 KiB tool result and rejects one byte above it before transport", async (t) => {
  const backend = router();
  const server = new LocalMcpServer(TOKEN, backend, { port: 0 });
  await server.listen();
  t.after(() => server.close());
  const client = new TestMcpClient(server.endpoint, TOKEN);
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
