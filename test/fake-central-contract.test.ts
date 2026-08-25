import assert from "node:assert/strict";
import test from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { TestMcpClient } from "./support/mcp-client.js";

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
  assert.equal(verification.token, central.jwt);

  const pollIds = async (): Promise<Response> =>
    await fetch(`${central.apiUrl}/api/poll_messages?timeout=0&view=ids`, {
      headers: { authorization: `Bearer ${central.jwt}` },
    });
  const firstIds = await pollIds();
  assert.equal(firstIds.status, 200);
  assert.deepEqual(await firstIds.json(), { messages: [{ id: messageId }] });

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
  assert.deepEqual(contentPoll, { messages: [{ id: messageId, content }] });

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
