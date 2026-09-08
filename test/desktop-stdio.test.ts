import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { desktopRelayEndpoint, desktopRelayTool } from "../src/desktop-stdio.js";
import { LocalMcpServer, LocalMcpToolError } from "../src/local-mcp.js";
import { MESSAGE_BOX_TOOL } from "../src/message-box.js";

test("desktop relay keeps the ten-minute default and continuation in tool help without changing validation", () => {
  const adapted = desktopRelayTool(MESSAGE_BOX_TOOL);
  assert.match(adapted.description ?? "", /600/u);
  assert.match(adapted.description ?? "", /request_id/u);
  assert.doesNotMatch(JSON.stringify(adapted), /wait_seconds: 45|use 45 seconds/u);
  const stripDescriptions = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripDescriptions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "description")
        .map(([key, item]) => [key, stripDescriptions(item)]),
    );
  };
  assert.deepEqual(
    stripDescriptions(adapted.inputSchema),
    stripDescriptions(MESSAGE_BOX_TOOL.inputSchema),
  );
  assert.match(JSON.stringify(adapted.inputSchema), /600/u);
  assert.match(JSON.stringify(MESSAGE_BOX_TOOL.inputSchema), /Omit to wait up to 600/u);
  const ordinary = { name: "list_action_types", inputSchema: { type: "object" } };
  assert.equal(desktopRelayTool(ordinary), ordinary);
});

test("desktop relay accepts only an explicit local port", () => {
  assert.equal(desktopRelayEndpoint(undefined).href, "http://127.0.0.1:8787/mcp");
  assert.equal(desktopRelayEndpoint("9797").href, "http://127.0.0.1:9797/mcp");
  for (const value of ["0", "80", "65536", " 8787", "8787/path", "https://other.test", "08787"])
    assert.throws(() => desktopRelayEndpoint(value));
});

test("desktop stdio preserves the foreground request and explicit receipt", {
  timeout: 10000,
}, async (t) => {
  const requestId = randomUUID();
  const inputs: Record<string, unknown>[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  let arrived!: () => void;
  const started = new Promise<void>((done) => {
    arrived = done;
  });
  let progressed!: () => void;
  const progress = new Promise<void>((done) => {
    progressed = done;
  });
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool(name, input, _signal, info) {
        assert.equal(name, "message_box");
        assert.equal(info?.name, "embassys-desktop-relay");
        inputs.push(input);
        if (input.type === "request_action") {
          arrived();
          await waiting;
        }
        return {
          status: "completed",
          request_id: requestId,
          result: { phone_number: "test-only" },
        };
      },
    },
    { port: 0, keepAliveMs: 10 },
  );
  await server.listen();
  const client = new Client({ name: "claude-ai", version: "fixture" });
  t.after(async () => {
    release();
    await client.close();
    await server.close();
  });
  const module = pathToFileURL(resolve(".test-dist/src/desktop-stdio.js")).href;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `import {openDesktopRelay} from ${JSON.stringify(module)}; await openDesktopRelay({port:${JSON.stringify(new URL(server.endpoint).port)}});`,
      ],
      stderr: "pipe",
    }),
  );
  assert.match(client.getInstructions() ?? "", /Embassys/);
  assert.match(client.getInstructions() ?? "", /600/u);
  assert.match(client.getInstructions() ?? "", /does not mean the server crashed/u);
  const tool = (await client.listTools()).tools[0];
  assert.equal(tool?.name, "message_box");
  assert.match(tool?.description ?? "", /600/u);
  const input = {
    type: "request_action",
    request_id: requestId,
    wait_seconds: 37,
    payload: { reason: "owner request" },
  };
  let finished = false;
  const result = client
    .callTool({ name: "message_box", arguments: input }, { onprogress: () => progressed() })
    .then((value) => {
      finished = true;
      return value;
    });
  await started;
  assert.equal(finished, false);
  assert.deepEqual(inputs, [input]);
  await progress;
  assert.equal(finished, false, "Progress must not complete the held request.");
  release();
  assert.match(JSON.stringify(await result), /test-only/);
  assert.deepEqual(inputs, [input], "The relay must not acknowledge or resubmit.");
  await client.callTool({
    name: "message_box",
    arguments: { type: "acknowledge", request_id: requestId, cursor: "exact" },
  });
  assert.deepEqual(inputs[1], { type: "acknowledge", request_id: requestId, cursor: "exact" });
  const check = { type: "check", request_id: requestId };
  await client.callTool({ name: "message_box", arguments: check });
  assert.deepEqual(
    inputs[2],
    check,
    "Omitting wait_seconds must preserve the gateway's ten-minute default.",
  );
});

test("desktop stdio propagates tool failure and cancels upstream when its caller closes", {
  timeout: 10000,
}, async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let cancelled!: () => void;
  const aborted = new Promise<void>((done) => {
    cancelled = done;
  });
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool(_name, input, signal) {
        calls++;
        if (input.type === "fail")
          throw new LocalMcpToolError("central_rate_limited", 5000, "fixture");
        signal?.addEventListener(
          "abort",
          () => {
            cancelled();
            release();
          },
          { once: true },
        );
        entered();
        await waiting;
        return { status: "pending" };
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new Client({ name: "claude-ai", version: "fixture" });
  t.after(async () => {
    release();
    await client.close();
    await server.close();
  });
  const module = pathToFileURL(resolve(".test-dist/src/desktop-stdio.js")).href;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `import {openDesktopRelay} from ${JSON.stringify(module)}; await openDesktopRelay({port:${JSON.stringify(new URL(server.endpoint).port)}});`,
      ],
      stderr: "pipe",
    }),
  );
  await assert.rejects(client.callTool({ name: "message_box", arguments: { type: "fail" } }), {
    code: -32602,
    data: { code: "central_rate_limited", retry_after_ms: 5000, source: "fixture" },
  });
  const pending = client.callTool({ name: "message_box", arguments: { type: "check" } });
  const rejected = assert.rejects(pending);
  await started;
  await client.close();
  await Promise.all([rejected, aborted]);
  assert.equal(calls, 2, "Neither failure nor cancellation is replayed.");
});

test("desktop stdio cancels one wait without closing the usable connection", {
  timeout: 10000,
}, async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let cancelled!: () => void;
  const aborted = new Promise<void>((done) => {
    cancelled = done;
  });
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool(_name, input, signal) {
        calls++;
        if (input.type === "check") {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              release();
            },
            { once: true },
          );
          entered();
          await waiting;
        }
        return { status: "pending" };
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new Client({ name: "claude-ai", version: "fixture" });
  t.after(async () => {
    release();
    await client.close();
    await server.close();
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(".test-dist/src/desktop-stdio.js")],
      env: { EMBASSYS_MCP_PORT: new URL(server.endpoint).port },
      stderr: "pipe",
    }),
  );
  const controller = new AbortController();
  const pending = client.callTool(
    { name: "message_box", arguments: { type: "check" } },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await Promise.all([rejected, aborted]);
  await client.callTool({ name: "message_box", arguments: { type: "inbox" } });
  assert.equal(calls, 2, "Cancellation must not replay work or break later reads.");
});

test("desktop stdio starts from a symlinked package path", { timeout: 10000 }, async (t) => {
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "embassys-relay-alias-"));
  const directoryAlias = join(root, "package");
  await symlink(
    resolve(".test-dist/src"),
    directoryAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const alias = join(directoryAlias, "desktop-stdio.js");
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool() {
        return { status: "pending" };
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new Client({ name: "desktop-alias-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [alias],
      env: { EMBASSYS_MCP_PORT: new URL(server.endpoint).port },
      stderr: "pipe",
    }),
  );
  assert.equal((await client.listTools()).tools[0]?.name, "message_box");
});
