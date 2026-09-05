import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LocalMcpServer } from "../src/local-mcp.js";

test("the opt-in channel proxies tools and sends a result to its own stdio conversation", {
  timeout: 10_000,
}, async (t) => {
  const requestId = randomUUID();
  const cursor = randomUUID();
  let release!: () => void;
  const resultReady = new Promise<void>((done) => {
    release = done;
  });
  let arrived!: (message: unknown) => void;
  const notification = new Promise<unknown>((done) => {
    arrived = done;
  });
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [{ name: "message_box", inputSchema: { type: "object" } }];
      },
      async callTool(name, input, _signal, info) {
        assert.equal(name, "message_box");
        assert.equal(info?.name, "claude-code");
        if (input.type === "request_action") {
          assert.equal(input.wait_seconds, 0);
          return { request_id: requestId, status: "pending", events: [] };
        }
        assert.equal(input.type, "check");
        await resultReady;
        return {
          request_id: requestId,
          status: "completed",
          cursor,
          events: [
            {
              cursor,
              type: "action_result",
              data: { result: { phone_number: "synthetic-channel-answer" } },
            },
          ],
        };
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new Client({ name: "claude-code", version: "fixture" });
  t.after(async () => {
    release();
    await client.close();
    await server.close();
  });
  client.fallbackNotificationHandler = async (message) => {
    if (message.method === "notifications/claude/channel") arrived(message);
  };
  const module = pathToFileURL(resolve(".test-dist/src/claude-channel.js")).href;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `import {openClaudeChannel} from ${JSON.stringify(module)}; await openClaudeChannel({endpoint:${JSON.stringify(server.endpoint)}});`,
      ],
      stderr: "pipe",
    }),
  );
  assert.match(client.getInstructions() ?? "", /Embassys Ambassador connects this local agent/u);
  assert.match(client.getInstructions() ?? "", /target person's human decides permissions/u);
  assert.equal((await client.listTools()).tools[0]?.name, "message_box");
  const accepted = await client.callTool({
    name: "message_box",
    arguments: { type: "request_action", request_id: requestId },
  });
  assert.match(JSON.stringify(accepted), /pending/u);
  release();
  assert.match(JSON.stringify(await notification), /synthetic-channel-answer/u);
});
