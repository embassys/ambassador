import assert from "node:assert/strict";
import test from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";

test("the Node central fixture keeps notification and content acknowledgements independent", async (t) => {
  const central = await startFakeCentral(t);
  const messageId = "message_contract_01";
  const content = "content returned only through MCP";
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

  const pollIds = async (): Promise<Response> =>
    await fetch(`${central.apiUrl}/api/poll_messages?timeout=30&view=ids`, {
      headers: { authorization: `Bearer ${central.jwt}` },
    });
  const firstIds = await pollIds();
  assert.equal(firstIds.status, 200);
  assert.deepEqual(await firstIds.json(), { messages: [{ id: messageId }] });

  const extraQuery = await fetch(
    `${central.apiUrl}/api/poll_messages?timeout=30&view=ids&selector=other-agent`,
    { headers: { authorization: `Bearer ${central.jwt}` } },
  );
  assert.equal(extraQuery.status, 422);

  const extraAcknowledgement = await fetch(`${central.apiUrl}/api/ack_notification`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${central.jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message_id: messageId, agent_id: "other-agent" }),
  });
  assert.equal(extraAcknowledgement.status, 422);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acknowledgement = await fetch(`${central.apiUrl}/api/ack_notification`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message_id: messageId }),
    });
    assert.equal(acknowledgement.status, 200);
  }
  const acknowledgedIds = await pollIds();
  assert.deepEqual(await acknowledgedIds.json(), { messages: [] });

  const contentPoll = await client.callTool("poll_messages", {
    token: central.jwt,
    timeout: 0,
  });
  const messages = contentPoll.messages;
  assert.ok(Array.isArray(messages) && messages.length === 1);
  const message = messages[0] as Record<string, unknown>;
  assert.equal(message.id, messageId);
  assert.ok(message.content === content);
  await assert.rejects(
    client.callTool("poll_messages", {
      token: central.jwt,
      timeout: 0,
      agent_id: "other-agent",
    }),
    (error: unknown) => error instanceof McpCallError,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contentAcknowledgement = await client.callTool("ack_message", {
      token: central.jwt,
      message_id: messageId,
    });
    assert.deepEqual(contentAcknowledgement, { acknowledged: true, message_id: messageId });
  }
  assert.deepEqual(await client.callTool("poll_messages", { token: central.jwt, timeout: 0 }), {
    messages: [],
  });
});
