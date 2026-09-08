import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMcpServer } from "../src/local-mcp.js";
import { NativeBoxClient } from "../src/native-box-client.js";
import { NativeConversationBridge, NativeRouteStore } from "../src/native-conversation-bridge.js";
import { nativeRouteNamespace, openClawReturnEndpoint } from "../src/openclaw-return-endpoint.js";

const configuration = (entry: unknown) => ({ mcp: { servers: { ambassador: entry } } });

test("OpenClaw return uses the owner's exact local MCP endpoint and separates its routes", () => {
  const first = openClawReturnEndpoint(
    configuration({
      url: "http://127.0.0.1:8787/mcp",
      transport: "streamable-http",
    }),
  );
  const second = openClawReturnEndpoint(
    configuration({
      url: "http://127.0.0.1:9797/mcp",
      transport: "streamable-http",
      enabled: true,
    }),
  );
  assert.equal(first, "http://127.0.0.1:8787/mcp");
  assert.equal(second, "http://127.0.0.1:9797/mcp");
  assert.notEqual(nativeRouteNamespace(first), nativeRouteNamespace(second));
  assert.equal(nativeRouteNamespace(first), nativeRouteNamespace(first));
  assert.match(nativeRouteNamespace(first), /^[a-f0-9]{64}$/u);
});

test("two real MCP instances keep the same request UUID in separate native conversations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-native-instances-"));
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  const id = randomUUID();
  const deliveries: string[] = [];
  for (const name of ["first", "second"]) {
    const server = new LocalMcpServer(
      {
        async listTools() {
          return [{ name: "message_box", inputSchema: { type: "object" } }];
        },
        async callTool(_name, input) {
          assert.equal(input.type, "check");
          assert.equal(input.request_id, id);
          return {
            request_id: id,
            status: "completed",
            cursor: randomUUID(),
            events: [{ type: "action_result", data: { result: { source: name } } }],
          };
        },
      },
      { port: 0 },
    );
    await server.listen();
    cleanup.push(() => server.close());
    const endpoint = openClawReturnEndpoint(configuration({ url: server.endpoint }));
    const client = new NativeBoxClient(endpoint);
    const store = new NativeRouteStore(join(root, `${nativeRouteNamespace(endpoint)}.sqlite`));
    const bridge = new NativeConversationBridge({
      store,
      callBox: (input, signal) => client.call(input, signal),
      async deliver(conversation, message) {
        assert.equal(conversation, name);
        assert.match(message, new RegExp(name));
        deliveries.push(conversation);
        return "accepted";
      },
    });
    cleanup.push(async () => {
      await bridge.close();
      await client.close();
      store.close();
    });
    bridge.bind(id, name);
    await bridge.observe(id);
    assert.equal(store.get(id)?.status, "accepted");
    await bridge.resume();
  }
  assert.deepEqual(deliveries, ["first", "second"]);
});

test("missing, disabled or incompatible MCP settings never fall back to the default instance", () => {
  for (const entry of [
    undefined,
    null,
    {},
    { url: "http://127.0.0.1:9797/mcp", enabled: false },
    { url: "http://127.0.0.1:9797/mcp", transport: "sse" },
    { url: "http://127.0.0.1:9797/mcp", command: "node" },
    { url: "http://127.0.0.1:9797/mcp", headers: { Authorization: "secret" } },
  ])
    assert.throws(() => openClawReturnEndpoint(configuration(entry)));
  for (const config of [
    undefined,
    {},
    { mcp: { enabled: false, servers: { ambassador: { url: "http://127.0.0.1:8787/mcp" } } } },
  ])
    assert.throws(() => openClawReturnEndpoint(config));
});

test("native observers reject remote, credential-bearing and noncanonical endpoints before connecting", () => {
  for (const url of [
    "https://example.com/mcp",
    "http://localhost:8787/mcp",
    "http://127.0.0.2:8787/mcp",
    "http://127.0.0.1:8787/mcp?token=secret",
    "http://127.0.0.1:8787/mcp#fragment",
    "http://user:secret@127.0.0.1:8787/mcp",
    "http://127.0.0.1:8787/other",
    "http://127.0.0.1:0/mcp",
    "http://127.0.0.1:65536/mcp",
    "http://127.0.0.1:08787/mcp",
    "http://127.1:8787/mcp",
    " http://127.0.0.1:8787/mcp",
    "http://127.0.0.1:8787/mcp\n",
  ]) {
    assert.throws(() => new NativeBoxClient(url), /local MCP endpoint/);
    assert.throws(() => openClawReturnEndpoint(configuration({ url })));
  }
});
