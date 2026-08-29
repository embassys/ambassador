import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  seededCredentialV2,
  T03_WEBHOOK_TOKEN,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";
import {
  startT03ScriptedCentralApi,
  type T03ResponsePlan,
  type T03ScriptedRequest,
  waitForT03Observation,
} from "./support/t03-observation.js";

const RESOURCE_NONCE = "D".repeat(76);

function requestMessage(request: T03ScriptedRequest): Record<string, unknown> {
  const value = JSON.parse(request.body.toString("utf8")) as unknown;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function rpcResult(request: T03ScriptedRequest, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: requestMessage(request).id, result });
}

function proofPayload(request: T03ScriptedRequest): Record<string, unknown> {
  const proof = request.headers.dpop;
  assert.ok(typeof proof === "string", "central transport request omitted its DPoP proof");
  const payload = proof.split(".")[1];
  assert.ok(payload !== undefined);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function normalizeHtu(value: string): string {
  const target = new URL(value);
  target.hash = "";
  target.search = "";
  target.pathname = (target.pathname || "/").replace(/%[0-9a-fA-F]{2}/gu, (encoded) => {
    const byte = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/u.test(character) ? character : `%${encoded.slice(1).toUpperCase()}`;
  });
  return target.href;
}

function mcpPlans(): T03ResponsePlan[] {
  return [
    {
      method: "POST",
      status: 401,
      headers: {
        "cache-control": "no-store",
        "dpop-nonce": RESOURCE_NONCE,
        "www-authenticate": 'DPoP error="use_dpop_nonce"',
      },
    },
    {
      method: "POST",
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "mcp-session-id": "t03-session",
      },
      body: (request) =>
        rpcResult(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "t03-scripted-central", version: "2" },
        }),
    },
    { method: "POST", status: 202, headers: { "cache-control": "no-store" } },
    {
      method: "GET",
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "text/event-stream" },
      hold: true,
    },
    {
      method: "POST",
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: (request) =>
        rpcResult(request, {
          tools: [
            {
              name: "list_action_types",
              description: "fixture tool",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        }),
    },
    { method: "POST", status: 200, headers: { "cache-control": "no-store" }, hold: true },
    { method: "DELETE", status: 204, headers: { "cache-control": "no-store" } },
  ];
}

test("T03-P01 MCP initialize, catalog, reconnect, call cancellation, and close each use fresh DPoP", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const credential = seededCredentialV2(central, "fixture_sender");
  const api = await startT03ScriptedCentralApi(t, [{ status: 200, hold: true }]);
  const mcp = await startT03ScriptedCentralApi(t, mcpPlans());
  const webhook = await startFakeWebhook(t);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: api.url,
    centralMcpUrl: `${mcp.url}/mcp`,
    credentialStore: capturingCredentialStore(JSON.stringify(credential)).adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await client.listTools();
  const call = client.callTool("list_action_types", {});
  await waitForT03Observation(() =>
    mcp.requests.some((request) => requestMessage(request).method === "tools/call"),
  );
  const stopping = gateway.stop();
  await assert.rejects(call);
  await stopping;
  await waitForT03Observation(() => mcp.requests.some((request) => request.method === "DELETE"));

  const methods = mcp.requests.map((request) => request.method);
  assert.ok(methods.includes("GET"), "central MCP reconnect did not occur");
  assert.ok(methods.includes("DELETE"), "central MCP session close did not occur");
  const rpcMethods = mcp.requests
    .filter((request) => request.body.byteLength > 0)
    .map((request) => requestMessage(request).method);
  for (const expected of ["initialize", "notifications/initialized", "tools/list", "tools/call"]) {
    assert.ok(rpcMethods.includes(expected), `central MCP omitted ${expected}`);
  }

  const proofs = new Set<string>();
  for (const [index, request] of mcp.requests.entries()) {
    assert.ok(
      request.headers.authorization === `DPoP ${credential.access_token}`,
      "central MCP request did not use DPoP authorization",
    );
    const proof = request.headers.dpop;
    assert.ok(typeof proof === "string");
    assert.ok(!proofs.has(proof), "central MCP request replayed a proof");
    proofs.add(proof);
    const payload = proofPayload(request);
    assert.ok(payload.htm === request.method);
    assert.ok(payload.htu === normalizeHtu(`${mcp.url}/mcp`));
    assert.ok(
      payload.ath === createHash("sha256").update(credential.access_token).digest("base64url"),
    );
    if (index === 0) assert.equal(payload.nonce, undefined);
    else assert.equal(payload.nonce, RESOURCE_NONCE, "MCP request omitted its current nonce");
  }
  const cancelled = mcp.requests.find(
    (request) => request.body.byteLength > 0 && requestMessage(request).method === "tools/call",
  );
  assert.ok(cancelled?.connectionClosed(), "cancelled call stayed open");
});

test("T03-P02 protected proof rejection never triggers refresh, reissue, or bearer fallback", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const credential = seededCredentialV2(central, "fixture_sender");
  const api = await startT03ScriptedCentralApi(t, [{ status: 200, hold: true }]);
  const mcp = await startT03ScriptedCentralApi(t, [
    {
      method: "POST",
      path: "/mcp",
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'DPoP error="invalid_dpop_proof"',
      },
    },
  ]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore(JSON.stringify(credential));
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: api.url,
    centralMcpUrl: `${mcp.url}/mcp`,
    credentialStore: credentials.adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await assert.rejects(client.listTools());
  const authorization = mcp.requests[0]?.headers.authorization;
  assert.ok(typeof authorization === "string" && authorization.startsWith("DPoP "));
  assert.equal(mcp.requests.length, 1, "proof rejection was retried");
  assert.equal(credentials.saved.length, 0, "proof rejection replaced the credential");
  assert.ok(
    !api.requests.some((request) => request.path === "/api/v2/token/reissue"),
    "proof rejection triggered reissue",
  );
});
