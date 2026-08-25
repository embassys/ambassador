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
  await assert.rejects(client.callTool("mismatched_content", {}), (error: unknown) =>
    assertSafeError(error, "central_mcp_response_invalid"),
  );
  assert.deepEqual(fixture.callNames, [
    "tool_failure",
    "protocol_failure",
    "authentication_failure",
    "duplicate_content",
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
