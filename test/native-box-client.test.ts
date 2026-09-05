import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMcpServer } from "../src/local-mcp.js";
import { NativeBoxClient } from "../src/native-box-client.js";

test("native checks reconnect after Ambassador restarts at the same endpoint", async (t) => {
  let calls = 0;
  const dispatcher = {
    async listTools() {
      return [{ name: "message_box", inputSchema: { type: "object" } }];
    },
    async callTool(_name: string, input: Record<string, unknown>) {
      calls++;
      return { request_id: input.request_id, status: "completed", events: [] };
    },
  };
  let server = new LocalMcpServer(dispatcher, { port: 0 });
  await server.listen();
  const endpoint = server.endpoint;
  const client = new NativeBoxClient(endpoint);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const signal = new AbortController().signal;
  await client.call({ type: "check", request_id: "saved" }, signal);
  await server.close();
  server = new LocalMcpServer(dispatcher, { port: Number(new URL(endpoint).port) });
  await server.listen();
  const result = await client.call({ type: "check", request_id: "saved" }, signal);
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  await assert.rejects(client.call({ type: "request_action" }, signal), /Only checks and receipts/);
  assert.equal(calls, 2);
  await client.close();
  await assert.rejects(client.call({ type: "check" }, signal), /closed/);
});
