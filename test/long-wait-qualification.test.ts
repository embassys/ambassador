import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ActionResultInbox } from "../src/action-result-inbox.js";
import { parseCentralCredential } from "../src/central-credential.js";
import { LocalMcpServer } from "../src/local-mcp.js";
import { MESSAGE_BOX_TOOL, MessageBox } from "../src/message-box.js";
import { OutboundActions } from "../src/outbound-actions.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

test("wall-clock qualification: initial MCP request waits ten minutes and a later check resumes the same action", {
  skip: process.env.AMBASSADOR_LONG_WAIT_QUALIFICATION !== "1",
  timeout: 650_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-full-wait-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const permissionId = randomUUID();
  const callId = randomUUID();
  let requests = 0;
  let calls = 0;
  const transport = {
    async listActionTypes() {
      return [
        {
          id: "fixture-action",
          name: "lookup",
          description: "Test lookup",
          input_schema: { type: "object" },
        },
      ];
    },
    async requestPermission() {
      requests++;
      return { permission_id: permissionId, status: "pending" as const, message: "Pending" };
    },
    async callAction() {
      calls++;
      return { call_id: callId, message_id: randomUUID(), status: "delivered" };
    },
    async submitActionResult() {
      throw new Error("No result submission expected");
    },
  };
  const pending = new PendingActionInbox(join(root, "pending.sqlite"), credential);
  const results = new ActionResultInbox(join(root, "results.sqlite"), credential);
  const outbound = new OutboundActions(join(root, "outbound.sqlite"), credential, transport);
  const box = new MessageBox({
    path: join(root, "operations.sqlite"),
    credential,
    pending,
    results,
    outbound,
    transport,
  });
  const server = new LocalMcpServer(
    {
      async listTools() {
        return [MESSAGE_BOX_TOOL];
      },
      async callTool(_name, input, signal) {
        return await box.call(input, signal);
      },
    },
    { port: 0 },
  );
  await server.listen();
  const client = new Client({ name: "ambassador-wall-clock-qualification", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    await box.close();
    pending.close();
    results.close();
    outbound.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
  const requestId = randomUUID();
  const started = performance.now();
  const first = await client.callTool(
    {
      name: "message_box",
      arguments: {
        type: "request_action",
        request_id: requestId,
        target_email: "peer@example.test",
        action_type: "lookup",
        payload: {},
      },
    },
    { timeout: 640_000 },
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 599_500 && elapsed < 620_000, `actual wait: ${elapsed} ms`);
  assert.match(JSON.stringify(first), /wait_timeout/u);
  assert.equal(requests, 1);
  assert.equal(calls, 0);
  const second = client.callTool(
    { name: "message_box", arguments: { type: "check", request_id: requestId } },
    { timeout: 640_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await box.capture({
    id: randomUUID(),
    sender_agent_id: "peer",
    action_type_id: "fixture-action",
    created_at: new Date().toISOString(),
    payload: {
      type: "permission_outcome",
      permission_id: permissionId,
      action_type: "lookup",
      grantor_email: "peer@example.test",
      status: "granted",
      granted: true,
    },
  });
  assert.match(JSON.stringify(await second), /permission_status/u);
  assert.equal(requests, 1);
  assert.equal(calls, 1);
  t.diagnostic(
    `Measured ${Math.round(elapsed)} ms over local Streamable HTTP with the real SDK and MessageBox. Central transport was a controlled fixture.`,
  );
});
