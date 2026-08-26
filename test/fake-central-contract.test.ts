import assert from "node:assert/strict";
import test from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";

test("the Node central fixture consumes full messages and acknowledges delivered IDs", async (t) => {
  const central = await startFakeCentral(t);
  const messageId = "message_contract_01";
  const content = "content returned by the consuming REST poll";
  central.injectMessage(messageId, content);

  const client = new TestMcpClient(central.mcpUrl, "unused-local-transport-token");
  await client.initialize();
  await client.callTool("register_agent", {
    username: "fixture-agent",
    email: "fixture-agent@example.test",
  });
  const verification = await client.callTool("verify_email", {
    email: "fixture-agent@example.test",
    code: "246810",
  });
  assert.ok(verification.token === central.jwt);

  const poll = async (): Promise<Response> =>
    await fetch(`${central.apiUrl}/api/poll_messages?timeout=30`, {
      headers: { authorization: `Bearer ${central.jwt}` },
    });
  const first = await poll();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { messages: [{ id: messageId, content }] });
  assert.deepEqual(await (await poll()).json(), { messages: [] });

  const contentPoll = await client.callTool("poll_messages", {
    token: central.jwt,
    timeout: 0,
  });
  assert.deepEqual(contentPoll, { messages: [] });
  await assert.rejects(
    client.callTool("poll_messages", {
      token: central.jwt,
      timeout: 0,
      agent_id: "other-agent",
    }),
    (error: unknown) => error instanceof McpCallError,
  );

  const contentAcknowledgement = await client.callTool("ack_message", {
    token: central.jwt,
    message_id: messageId,
  });
  assert.deepEqual(contentAcknowledgement, { message_id: messageId, status: "acked" });
  await assert.rejects(
    client.callTool("ack_message", { token: central.jwt, message_id: messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
});
