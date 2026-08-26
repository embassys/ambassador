import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startFakeCentral } from "./support/fake-central.js";
import { startGatewayProcess } from "./support/gateway-process.js";
import { TestMcpClient } from "./support/mcp-client.js";

const GATEWAY_CLI = process.env.A2A_PACKED_GATEWAY_CLI;
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MESSAGE_ID = "hermes_message_01";
const EMAIL = "hermes-agent@example.test";
const CODE = "246810";

async function startHermesWebhook(): Promise<{
  url: string;
  close: () => Promise<void>;
  waitForWake: () => Promise<{ headers: IncomingHttpHeaders; body: Buffer; status: number }>;
}> {
  let resolveWake:
    | ((wake: { headers: IncomingHttpHeaders; body: Buffer; status: number }) => void)
    | undefined;
  const wake = new Promise<{ headers: IncomingHttpHeaders; body: Buffer; status: number }>(
    (resolve) => {
      resolveWake = resolve;
    },
  );
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(request.headers["x-webhook-timestamp"] ?? "");
      const expectedSignature = createHmac("sha256", WEBHOOK_TOKEN)
        .update(timestamp)
        .update(".")
        .update(body)
        .digest("hex");
      const timestampSeconds = Number(timestamp);
      const authenticated =
        request.method === "POST" &&
        request.url === "/webhooks/a2a" &&
        Number.isInteger(timestampSeconds) &&
        Math.abs(Date.now() / 1_000 - timestampSeconds) <= 10 &&
        request.headers["x-webhook-signature-v2"] === expectedSignature;
      const status = authenticated ? 202 : 401;
      resolveWake?.({ headers: request.headers, body, status });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(authenticated ? '{"status":"accepted"}' : '{"error":"Invalid signature"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhooks/a2a`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    waitForWake: async () =>
      await Promise.race([
        wake,
        delay(10_000, undefined, { ref: false }).then(() =>
          assert.fail("Hermes did not receive the gateway wake"),
        ),
      ]),
  };
}

test("the packaged gateway directly authenticates to a Hermes webhook", {
  skip: GATEWAY_CLI === undefined,
  timeout: 30_000,
}, async (t) => {
  assert.ok(GATEWAY_CLI !== undefined);
  const hermes = await startHermesWebhook();
  t.after(hermes.close);
  const central = await startFakeCentral(t);
  const gateway = await startGatewayProcess(t, {
    webhookUrl: hermes.url,
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    executable: GATEWAY_CLI,
  });
  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await client.initialize();
  await client.callTool("register_agent", {
    username: "hermes-agent",
    email: EMAIL,
    display_name: "Hermes Agent",
  });
  await client.callTool("verify_email", { email: EMAIL, code: CODE });

  central.injectMessage(MESSAGE_ID, "Hermes interoperability content");
  const wake = await hermes.waitForWake();
  assert.equal(wake.status, 202);
  assert.equal(wake.headers.authorization, `Bearer ${WEBHOOK_TOKEN}`);
  assert.equal(wake.headers["idempotency-key"], MESSAGE_ID);
  assert.equal(wake.headers["x-request-id"], MESSAGE_ID);
  assert.deepEqual(JSON.parse(wake.body.toString("utf8")), {
    message: `A2A message ${MESSAGE_ID} is ready. Use the A2A MCP tools to retrieve and process it.`,
    name: "A2A Gateway",
    deliver: false,
    wakeMode: "now",
  });

  const stopped = await gateway.stop();
  assert.equal(stopped.code, 0);
  assert.ok(!gateway.stdout().includes(WEBHOOK_TOKEN));
  assert.ok(!gateway.stderr().includes(WEBHOOK_TOKEN));
});
