import assert from "node:assert/strict";
import test from "node:test";

import { installT04FetchInterceptor, t04JsonResponse } from "./support/t04-fetch-interceptor.js";
import {
  requireT04Tool,
  startT04GatewayScenario,
  T04_USERNAME,
  T04_WEBHOOK_TOKEN,
} from "./support/t04-gateway-harness.js";
import { T04RawMcpClient } from "./support/t04-raw-mcp.js";

const START_PROPERTIES = ["payload", "recipient_username", "request_id"];

test("T04-V05 uses the fixed start route and rejects redirects without reflection", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-V05-start");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const marker = "t04-redirect-remote-marker-649f31";
  const trapPath = `/t04-reflection-trap-${marker}`;
  const interceptor = installT04FetchInterceptor(t, async (_request, call) => {
    if (call.origin !== scenario.central.apiUrl) return undefined;
    if (call.method === "POST" && call.pathname === "/api/v2/conversations") {
      return new Response(null, {
        status: 307,
        headers: {
          "cache-control": "no-store",
          location: `${scenario.central.apiUrl}${trapPath}`,
        },
      });
    }
    if (call.pathname === trapPath) {
      return t04JsonResponse(500, {
        error: { code: "temporarily_unavailable", retry_after_ms: null },
        marker,
      });
    }
    return undefined;
  });
  const rawClient = new T04RawMcpClient(scenario.gateway.endpoint, T04_WEBHOOK_TOKEN);
  await rawClient.initialize();
  const error = await rawClient.callToolError("start_conversation", {
    recipient_username: "fixture_recipient",
    payload: { text: "T04 redirect body must not be reflected 690f0d." },
    request_id: "00000000-0000-4000-8000-000000040201",
  });
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("fixture_recipient"), false);
  assert.equal(serialized.includes("690f0d"), false);
  assert.deepEqual(
    interceptor.calls
      .filter(
        (call) =>
          call.origin === scenario.central.apiUrl &&
          (call.pathname === "/api/v2/conversations" || call.pathname === trapPath),
      )
      .map((call) => `${call.method} ${call.pathname}`),
    ["POST /api/v2/conversations"],
  );
});

test("T04-E02 keeps DPoP challenges distinct from nested application errors", async (t) => {
  const scenario = await startT04GatewayScenario(t);
  await requireT04Tool(scenario.client, "start_conversation", START_PROPERTIES, "T04-E02");
  scenario.central.setConversationGrant("fixture_recipient", T04_USERNAME, true);
  const challengeMarker = "t04-invalid-dpop-nonce-2a70e8";
  let calls = 0;
  installT04FetchInterceptor(t, async (_request, call) => {
    if (
      call.origin !== scenario.central.apiUrl ||
      call.method !== "POST" ||
      call.pathname !== "/api/v2/conversations"
    ) {
      return undefined;
    }
    calls += 1;
    return new Response('{"error":"use_dpop_nonce"}', {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "dpop-nonce": challengeMarker,
        "www-authenticate": 'DPoP error="use_dpop_nonce"',
      },
    });
  });
  const rawClient = new T04RawMcpClient(scenario.gateway.endpoint, T04_WEBHOOK_TOKEN);
  await rawClient.initialize();
  const error = await rawClient.callToolError("start_conversation", {
    recipient_username: "fixture_recipient",
    payload: { text: "T04 DPoP challenge body remains secret-free 1ee90a." },
    request_id: "00000000-0000-4000-8000-000000040202",
  });
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(challengeMarker), false);
  assert.equal(serialized.includes("recipient_unavailable"), false);
  assert.equal(serialized.includes("retry_after_ms"), false);
  assert.equal(calls, 1, "gateway retried a malformed DPoP challenge");
});
