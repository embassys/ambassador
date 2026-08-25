import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

const CENTRAL_JWT = "fixture-central-jwt-never-expose-locally";
const VERIFICATION_CODE = "246810";

interface MessageRecord {
  id: string;
  content: string;
  notificationAcknowledged: boolean;
  contentAcknowledged: boolean;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > 1_048_576) {
      throw new Error("request too large");
    }
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): unknown {
  return {
    name,
    description: `${name} fixture tool`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const tools = [
  tool(
    "register_agent",
    {
      username: { type: "string" },
      email: { type: "string" },
      display_name: { type: "string" },
    },
    ["username", "email"],
  ),
  tool("verify_email", { email: { type: "string" }, code: { type: "string" } }, ["email", "code"]),
  tool("resend_verification", { email: { type: "string" } }, ["email"]),
  tool("poll_messages", { token: { type: "string" }, timeout: { type: "number" } }, ["token"]),
  tool("ack_message", { token: { type: "string" }, message_id: { type: "string" } }, [
    "token",
    "message_id",
  ]),
];

function toolResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    },
  };
}

export interface FakeCentral {
  apiUrl: string;
  mcpUrl: string;
  jwt: string;
  pollCount: () => number;
  calls: ToolCallRecord[];
  setVerificationResult: (result: Record<string, unknown> | undefined) => void;
  injectMessage: (id: string, content: string) => void;
  messageState: (id: string) => MessageRecord;
}

export async function startFakeCentral(t: TestContext): Promise<FakeCentral> {
  const messages = new Map<string, MessageRecord>();
  const calls: ToolCallRecord[] = [];
  let pollCount = 0;
  let verificationResult: Record<string, unknown> | undefined;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/poll_messages") {
        pollCount += 1;
        const query = [...url.searchParams.entries()];
        if (request.headers.authorization !== `Bearer ${CENTRAL_JWT}`) {
          json(response, 401, { detail: "unauthorized" });
          return;
        }
        if (
          url.searchParams.get("view") !== "ids" ||
          url.searchParams.get("timeout") !== "30" ||
          query.length !== 2
        ) {
          json(response, 422, { detail: "invalid query" });
          return;
        }
        json(response, 200, {
          messages: [...messages.values()]
            .filter((message) => !message.notificationAcknowledged)
            .map((message) => ({ id: message.id })),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ack_notification") {
        if (
          request.headers.authorization !== `Bearer ${CENTRAL_JWT}` ||
          request.headers["content-type"] !== "application/json"
        ) {
          json(response, 401, { detail: "unauthorized" });
          return;
        }
        const body = await readObject(request);
        if (!hasExactKeys(body, ["message_id"])) {
          json(response, 422, { detail: "invalid request" });
          return;
        }
        const message = messages.get(String(body.message_id));
        if (message === undefined) {
          json(response, 404, { detail: "not found" });
          return;
        }
        message.notificationAcknowledged = true;
        json(response, 200, { acknowledged: true, message_id: message.id });
        return;
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        const message = await readObject(request);
        const id = message.id;
        if (message.method === "initialize") {
          json(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "a2a-central-fixture", version: "1" },
            },
          });
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        if (message.method === "tools/list") {
          json(response, 200, { jsonrpc: "2.0", id, result: { tools } });
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
          const name = String(params?.name);
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          calls.push({ name, args: { ...args } });
          if (name === "register_agent") {
            if (!hasExactKeys(args, ["username", "email"], ["display_name"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            json(
              response,
              200,
              toolResult(id, {
                agent_id: "agent_fixture",
                username: args.username,
                email: args.email,
                message: "Verification code sent.",
              }),
            );
            return;
          }
          if (name === "verify_email") {
            if (!hasExactKeys(args, ["email", "code"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            if (args.code !== VERIFICATION_CODE) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_002, message: "verification failed" },
              });
              return;
            }
            json(
              response,
              200,
              toolResult(
                id,
                verificationResult ?? {
                  agent_id: "agent_fixture",
                  username: "fixture-agent",
                  token: CENTRAL_JWT,
                  message: "Email verified successfully.",
                },
              ),
            );
            return;
          }
          if (name === "resend_verification") {
            if (!hasExactKeys(args, ["email"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            json(
              response,
              200,
              toolResult(id, {
                message: "Verification code resent.",
                token: CENTRAL_JWT,
              }),
            );
            return;
          }
          if (
            (name === "poll_messages" && !hasExactKeys(args, ["token"], ["timeout"])) ||
            (name === "ack_message" && !hasExactKeys(args, ["token", "message_id"]))
          ) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32_602, message: "invalid arguments" },
            });
            return;
          }
          if (args.token !== CENTRAL_JWT) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32_001, message: "authentication failed" },
            });
            return;
          }
          if (name === "poll_messages") {
            json(
              response,
              200,
              toolResult(id, {
                messages: [...messages.values()]
                  .filter((item) => !item.contentAcknowledged)
                  .map((item) => ({ id: item.id, content: item.content })),
              }),
            );
            return;
          }
          if (name === "ack_message") {
            const item = messages.get(String(args.message_id));
            if (item === undefined) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_002, message: "message not found" },
              });
              return;
            }
            item.contentAcknowledged = true;
            json(response, 200, toolResult(id, { acknowledged: true, message_id: item.id }));
            return;
          }
        }
      }

      json(response, 404, { detail: "not found" });
    } catch {
      json(response, 500, { detail: "fixture error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    apiUrl: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    jwt: CENTRAL_JWT,
    pollCount: () => pollCount,
    calls,
    setVerificationResult(result) {
      verificationResult = result;
    },
    injectMessage(id, content) {
      messages.set(id, {
        id,
        content,
        notificationAcknowledged: false,
        contentAcknowledged: false,
      });
    },
    messageState(id) {
      const message = messages.get(id);
      assert.ok(message !== undefined);
      return { ...message };
    },
  };
}
