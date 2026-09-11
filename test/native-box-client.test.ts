import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMcpServer } from "../src/local-mcp.js";
import { NativeBoxClient } from "../src/native-box-client.js";

test("native reconnect survives a lost call and a lost replacement handshake", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool(_name, input) {
        seen.push(input);
        return { status: "completed", events: [] };
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new NativeBoxClient(server.endpoint);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const input = { type: "check", request_id: "saved" };
  const signal = new AbortController().signal;
  await client.call(input, signal);
  const original = globalThis.fetch;
  let failures = 0;
  t.mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST" && failures < 2) {
      failures++;
      throw new TypeError("fetch failed", { cause: new Error("other side closed") });
    }
    return original(url, init);
  });
  assert.equal((await client.call(input, signal)).status, "completed");
  assert.equal(failures, 2);
  assert.deepEqual(seen, [input, input]);
});

for (const cancelled of [false, true])
  test(
    cancelled ? "native reconnect stops when cancelled" : "native reconnect attempts stay bounded",
    async (t) => {
      const controller = new AbortController();
      const client = new NativeBoxClient("http://127.0.0.1:8787/mcp");
      t.after(() => client.close());
      let calls = 0;
      t.mock.method(globalThis, "fetch", () => {
        calls++;
        if (cancelled) controller.abort(new Error("Owner cancelled"));
        throw new TypeError("fetch failed");
      });
      await assert.rejects(
        client.call({ type: "check", request_id: "saved" }, controller.signal),
        cancelled ? /Owner cancelled/u : /fetch failed/u,
      );
      assert.equal(calls, cancelled ? 1 : 3);
    },
  );

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

test("cancelling during the reconnect pause never opens another connection", async (t) => {
  const controller = new AbortController();
  const client = new NativeBoxClient("http://127.0.0.1:8787/mcp");
  t.after(() => client.close());
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(timer));
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    timer = setTimeout(() => controller.abort(), 10);
    throw new TypeError("fetch failed");
  });
  await assert.rejects(client.call({ type: "check" }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});
