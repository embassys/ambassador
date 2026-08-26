import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import { CentralMcpClient, CentralMcpError } from "../src/central-mcp.js";
import { selectCentralTools } from "../src/mcp-contract.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_SECRET = "upstream-secret-must-not-escape";

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

interface CallContext {
  id: unknown;
  name: string;
  arguments: Record<string, unknown>;
  response: ServerResponse;
}

interface CentralFixtureOptions {
  tools?: unknown[];
  initialize?: (id: unknown, response: ServerResponse) => void | Promise<void>;
  call?: (context: CallContext) => void | Promise<void>;
}

interface CentralFixture {
  url: string;
  methods: string[];
  callNames: string[];
  initializeVersions: string[];
}

function writeJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeResult(response: ServerResponse, id: unknown, result: unknown): void {
  writeJson(response, { jsonrpc: "2.0", id, result });
}

function writeToolResult(
  response: ServerResponse,
  id: unknown,
  structuredContent: Record<string, unknown>,
): void {
  writeResult(response, id, {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

async function readMessage(request: IncomingMessage): Promise<RpcMessage> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcMessage;
}

async function startCentralFixture(
  t: TestContext,
  options: CentralFixtureOptions = {},
): Promise<CentralFixture> {
  const methods: string[] = [];
  const callNames: string[] = [];
  const initializeVersions: string[] = [];
  const tools = options.tools ?? [
    {
      name: "register_agent",
      description: "Register an agent",
      title: "field that must not escape",
      inputSchema: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    },
  ];

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(404);
        response.end();
        return;
      }

      const message = await readMessage(request);
      const method = String(message.method);
      methods.push(method);
      if (method === "initialize") {
        initializeVersions.push(String(message.params?.protocolVersion));
        if (options.initialize !== undefined) {
          await options.initialize(message.id, response);
          return;
        }
        writeResult(response, message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "central-mcp-test", version: "1" },
        });
        return;
      }
      if (method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (method === "tools/list") {
        writeResult(response, message.id, { tools });
        return;
      }
      if (method === "tools/call") {
        const name = String(message.params?.name);
        const arguments_ = (message.params?.arguments ?? {}) as Record<string, unknown>;
        callNames.push(name);
        if (options.call !== undefined) {
          await options.call({ id: message.id, name, arguments: arguments_, response });
          return;
        }
        writeToolResult(response, message.id, { ok: true });
        return;
      }

      response.writeHead(404);
      response.end();
    } catch {
      if (!response.headersSent) writeJson(response, { error: "fixture failure" }, 500);
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    callNames,
    initializeVersions,
  };
}

function assertSafeError(error: unknown, code: CentralMcpError["code"]): boolean {
  assert.ok(error instanceof CentralMcpError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(UPSTREAM_SECRET), false);
  assert.equal(error.message.includes("http://"), false);
  assert.equal("cause" in error, false);
  return true;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("connects lazily once across concurrent calls and returns strict plain tool definitions", async (t) => {
  let releaseInitialize: (() => void) | undefined;
  const initializeGate = new Promise<void>((resolve) => {
    releaseInitialize = resolve;
  });
  const fixture = await startCentralFixture(t, {
    initialize: async (id, response) => {
      await initializeGate;
      writeResult(response, id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "central-mcp-test", version: "1" },
      });
    },
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });
  t.after(() => client.close());

  assert.deepEqual(fixture.methods, []);
  const first = client.listTools();
  const second = client.listTools();
  await waitFor(() => fixture.methods.filter((method) => method === "initialize").length === 1);
  releaseInitialize?.();
  const [firstCatalog, secondCatalog] = await Promise.all([first, second]);

  assert.equal(fixture.methods.filter((method) => method === "initialize").length, 1);
  assert.deepEqual(fixture.initializeVersions, ["2025-06-18"]);
  assert.deepEqual(firstCatalog, secondCatalog);
  assert.deepEqual(firstCatalog, [
    {
      name: "register_agent",
      description: "Register an agent",
      inputSchema: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
        additionalProperties: false,
      },
    },
  ]);
  assert.equal(Object.getPrototypeOf(firstCatalog[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(firstCatalog[0]?.inputSchema), Object.prototype);
  assert.deepEqual(
    selectCentralTools(firstCatalog, false).map(({ name }) => name),
    ["register_agent"],
  );
});

test("returns only structuredContent while accepting one exact JSON text mirror", async (t) => {
  const structuredContent = {
    agent_id: "agent_fixture",
    username: "fixture-agent",
    token: UPSTREAM_SECRET,
    message: "Email verified successfully.",
  };
  const fixture = await startCentralFixture(t, {
    call: ({ id, response }) => writeToolResult(response, id, structuredContent),
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });
  t.after(() => client.close());

  const result = await client.callTool("verify_email", { code: "246810" });
  assert.deepEqual(result, structuredContent);
  assert.equal(Object.hasOwn(result, "content"), false);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test("turns tool, protocol, and noncanonical result failures into fixed safe errors", async (t) => {
  const fixture = await startCentralFixture(t, {
    call: ({ id, name, response }) => {
      if (name === "tool_failure") {
        writeResult(response, id, {
          isError: true,
          content: [{ type: "text", text: UPSTREAM_SECRET }],
        });
        return;
      }
      if (name === "protocol_failure") {
        writeJson(response, {
          jsonrpc: "2.0",
          id,
          error: { code: -32_020, message: UPSTREAM_SECRET, data: { token: UPSTREAM_SECRET } },
        });
        return;
      }
      if (name === "authentication_failure") {
        writeJson(response, {
          jsonrpc: "2.0",
          id,
          error: { code: -32_001, message: UPSTREAM_SECRET },
        });
        return;
      }
      if (name === "duplicate_content") {
        const text = JSON.stringify({ token: UPSTREAM_SECRET });
        writeResult(response, id, {
          structuredContent: { token: UPSTREAM_SECRET },
          content: [
            { type: "text", text },
            { type: "text", text },
          ],
        });
        return;
      }
      if (name === "standard_metadata") {
        writeResult(response, id, {
          structuredContent: { ok: true },
          content: [{ type: "text", text: '{"ok":true}' }],
          _meta: { source: "fixture" },
        });
        return;
      }
      if (name === "string_wrapped_object") {
        const text = JSON.stringify({ ok: true });
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
          _meta: { source: "fixture" },
        });
        return;
      }
      if (name === "string_wrapped_text") {
        writeResult(response, id, {
          structuredContent: { result: "accepted" },
          content: [{ type: "text", text: "accepted" }],
        });
        return;
      }
      if (name === "python_wrapped_object") {
        const text =
          "{'ok': True, 'items': [{'id': 'one', 'missing': None}], 'count': 1, 'ratio': -1.5e+2}";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_wrapped_array") {
        const text = "[{'name': 'send', 'enabled': True}, None]";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "json_wrapped_array") {
        const text = '[{"name":"send","enabled":true},null]';
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_wrapped_escapes") {
        const text = String.raw`{'message': "Agent's ready", 'escaped': 'line\nnext', 'unicode': '\u0041'}`;
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_unsupported_expression") {
        const text = "{'ok': __import__('os').system('false')}";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_json_keyword") {
        const text = "{'ok': true}";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "mixed_literal_keywords") {
        const text = "[None, null]";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_json_escape") {
        const text = String.raw`{'value': 'a\/b'}`;
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_prefixed_comment") {
        const text = "# unsupported\n{'token': 'hidden'}";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_wrapped_tuple") {
        const text = "({'token': 'hidden'},)";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_duplicate_key") {
        const text = "{'ok': True, 'ok': False}";
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "json_duplicate_key") {
        const text = '{"ok":true,"ok":false}';
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "python_depth_100" || name === "python_depth_101") {
        const depth = name === "python_depth_100" ? 100 : 101;
        const text = `${"{'value': ".repeat(depth)}'ok'${"}".repeat(depth)}`;
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
        });
        return;
      }
      if (name === "credential_metadata") {
        writeResult(response, id, {
          structuredContent: { ok: true },
          content: [{ type: "text", text: '{"ok":true}' }],
          _meta: { token: UPSTREAM_SECRET },
        });
        return;
      }
      if (name === "issued_credential_metadata") {
        const text = `{'agent_id': 'agent_fixture', 'username': 'fixture', 'token': '${UPSTREAM_SECRET}', 'message': 'verified'}`;
        writeResult(response, id, {
          structuredContent: { result: text },
          content: [{ type: "text", text }],
          _meta: { trace: UPSTREAM_SECRET },
        });
        return;
      }
      if (name === "stored_credential_metadata") {
        writeResult(response, id, {
          structuredContent: { ok: true },
          content: [{ type: "text", text: '{"ok":true}' }],
          _meta: { trace: UPSTREAM_SECRET },
        });
        return;
      }
      if (name === "content_credential_metadata") {
        writeResult(response, id, {
          structuredContent: { ok: true },
          content: [
            { type: "text", text: '{"ok":true}', _meta: { authorization: UPSTREAM_SECRET } },
          ],
        });
        return;
      }
      if (name === "unexpected_metadata") {
        writeResult(response, id, {
          structuredContent: { ok: true },
          content: [{ type: "text", text: '{"ok":true}' }],
          metadata: { token: UPSTREAM_SECRET },
        });
        return;
      }
      writeResult(response, id, {
        structuredContent: { token: UPSTREAM_SECRET },
        content: [{ type: "text", text: JSON.stringify({ token: "different" }) }],
      });
    },
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });
  t.after(() => client.close());

  await assert.rejects(client.callTool("tool_failure", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_request_failed"),
  );
  await assert.rejects(client.callTool("protocol_failure", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_request_failed"),
  );
  await assert.rejects(client.callTool("authentication_failure", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_authentication_failed"),
  );
  await assert.rejects(client.callTool("duplicate_content", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  assert.deepEqual(await client.callTool("standard_metadata", {}), { ok: true });
  assert.deepEqual(await client.callTool("string_wrapped_object", {}), { ok: true });
  assert.deepEqual(await client.callTool("string_wrapped_text", {}), { result: "accepted" });
  assert.deepEqual(await client.callTool("python_wrapped_object", {}), {
    ok: true,
    items: [{ id: "one", missing: null }],
    count: 1,
    ratio: -150,
  });
  assert.deepEqual(await client.callTool("python_wrapped_array", {}), {
    result: [{ name: "send", enabled: true }, null],
  });
  assert.deepEqual(await client.callTool("json_wrapped_array", {}), {
    result: [{ name: "send", enabled: true }, null],
  });
  assert.deepEqual(await client.callTool("python_wrapped_escapes", {}), {
    message: "Agent's ready",
    escaped: "line\nnext",
    unicode: "A",
  });
  await assert.rejects(client.callTool("python_unsupported_expression", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("python_json_keyword", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("mixed_literal_keywords", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("python_json_escape", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("python_prefixed_comment", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("python_wrapped_tuple", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("python_duplicate_key", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("json_duplicate_key", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  let depth100: unknown = "ok";
  for (let depth = 0; depth < 100; depth += 1) depth100 = { value: depth100 };
  assert.deepEqual(await client.callTool("python_depth_100", {}), depth100);
  await assert.rejects(client.callTool("python_depth_101", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("credential_metadata", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("issued_credential_metadata", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(
    client.callTool("stored_credential_metadata", {}, undefined, UPSTREAM_SECRET),
    (error: unknown) => assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("content_credential_metadata", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("unexpected_metadata", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  await assert.rejects(client.callTool("mismatched_content", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  assert.deepEqual(fixture.callNames, [
    "tool_failure",
    "protocol_failure",
    "authentication_failure",
    "duplicate_content",
    "standard_metadata",
    "string_wrapped_object",
    "string_wrapped_text",
    "python_wrapped_object",
    "python_wrapped_array",
    "json_wrapped_array",
    "python_wrapped_escapes",
    "python_unsupported_expression",
    "python_json_keyword",
    "mixed_literal_keywords",
    "python_json_escape",
    "python_prefixed_comment",
    "python_wrapped_tuple",
    "python_duplicate_key",
    "json_duplicate_key",
    "python_depth_100",
    "python_depth_101",
    "credential_metadata",
    "issued_credential_metadata",
    "stored_credential_metadata",
    "content_credential_metadata",
    "unexpected_metadata",
    "mismatched_content",
  ]);
});

test("rejects redirects without following them or exposing their target", async (t) => {
  let redirectedRequests = 0;
  const redirectedServer = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end();
  });
  await new Promise<void>((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        redirectedServer.closeAllConnections();
        redirectedServer.close(() => resolve());
      }),
  );
  const redirectedPort = (redirectedServer.address() as AddressInfo).port;
  const fixture = await startCentralFixture(t, {
    initialize: (_id, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${redirectedPort}/${UPSTREAM_SECRET}`,
      });
      response.end(UPSTREAM_SECRET);
    },
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });
  t.after(() => client.close());

  await assert.rejects(client.listTools(), (error: unknown) =>
    assertSafeError(error, "central_mcp_redirect_rejected"),
  );
  assert.equal(redirectedRequests, 0);
});

test("accepts a 4 MiB MCP response and rejects one byte above it", async (t) => {
  const startSizedFixture = async (responseBytes: number): Promise<CentralFixture> =>
    await startCentralFixture(t, {
      call: ({ id, response }) => {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
            structuredContent: { ok: true },
          },
        });
        assert.ok(Buffer.byteLength(body) < responseBytes);
        const padded = `${body}${" ".repeat(responseBytes - Buffer.byteLength(body))}`;
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(padded)),
        });
        response.end(padded);
      },
    });

  const acceptedFixture = await startSizedFixture(MAX_RESPONSE_BYTES);
  const acceptedClient = new CentralMcpClient({ centralMcpUrl: acceptedFixture.url });
  t.after(() => acceptedClient.close());
  assert.deepEqual(await acceptedClient.callTool("boundary", {}), { ok: true });

  const oversizedFixture = await startSizedFixture(MAX_RESPONSE_BYTES + 1);
  const oversizedClient = new CentralMcpClient({ centralMcpUrl: oversizedFixture.url });
  t.after(() => oversizedClient.close());
  await assert.rejects(oversizedClient.callTool("oversized", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_too_large"),
  );
});

test("caller cancellation and close abort in-flight requests", async (t) => {
  let startedCalls = 0;
  let closedResponses = 0;
  const fixture = await startCentralFixture(t, {
    call: ({ response }) => {
      startedCalls += 1;
      response.once("close", () => {
        closedResponses += 1;
      });
    },
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });

  const controller = new AbortController();
  const cancelled = client.callTool("cancelled", {}, controller.signal);
  await waitFor(() => startedCalls === 1);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) =>
    assertSafeError(error, "central_mcp_cancelled"),
  );
  await waitFor(() => closedResponses === 1);

  const closed = client.callTool("closed", {});
  await waitFor(() => startedCalls === 2);
  await client.close();
  await assert.rejects(closed, (error: unknown) => assertSafeError(error, "central_mcp_closed"));
  await waitFor(() => closedResponses === 2);
});

test("does not retry a tool call after an uncertain transport failure", async (t) => {
  const fixture = await startCentralFixture(t, {
    call: ({ response }) => {
      response.destroy(new Error(UPSTREAM_SECRET));
    },
  });
  const client = new CentralMcpClient({ centralMcpUrl: fixture.url });
  t.after(() => client.close());

  await assert.rejects(client.callTool("side_effect", { value: "sent-once" }), (error: unknown) =>
    assertSafeError(error, "central_mcp_request_failed"),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fixture.callNames, ["side_effect"]);
});

test("rejects invalid endpoint configuration with a fixed error", () => {
  assert.throws(
    () => new CentralMcpClient({ centralMcpUrl: `https://${UPSTREAM_SECRET}@central.invalid/mcp` }),
    (error: unknown) => assertSafeError(error, "invalid_configuration"),
  );
});
