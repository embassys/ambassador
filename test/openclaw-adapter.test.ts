import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OpenClawWebhookAdapter } from "../src/adapters/openclaw.js";
import type { FetchLike } from "../src/adapters/types.js";

const URL = "http://127.0.0.1:18789/hooks/agent";
const DELIVERY_ID = "delivery_01J6YP";
const TOKEN = "openclaw-hook-token";

function requestFrom(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

describe("OpenClawWebhookAdapter", () => {
  test("sends a fixed content-blind instruction and idempotency key", async () => {
    let captured: Request | undefined;
    const fetch: FetchLike = async (input, init) => {
      captured = requestFrom(input, init);
      return Response.json({ ok: true, runId: "run-local-42" });
    };
    const adapter = new OpenClawWebhookAdapter({
      url: URL,
      token: TOKEN,
      agentId: "agent-local",
      fetch,
    });

    assert.deepEqual(await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)), {
      protocol_version: 1,
      status: "accepted",
      session_id: "run-local-42",
    });

    assert.ok(captured);
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, URL);
    assert.equal(captured.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(captured.headers.get("idempotency-key"), DELIVERY_ID);
    assert.deepEqual(JSON.parse(await captured.text()), {
      message:
        "Claim and process A2A delivery delivery_01J6YP through your configured central MCP endpoint.",
      name: "A2A Sidecar",
      agentId: "agent-local",
      deliver: false,
      wakeMode: "now",
    });
  });

  test("rejects malformed success responses", async () => {
    const invalid = [
      { ok: true },
      { ok: false, runId: "run-local-42" },
      { ok: true, runId: "run-local-42", result: "forbidden" },
    ];
    for (const body of invalid) {
      const adapter = new OpenClawWebhookAdapter({
        url: URL,
        token: TOKEN,
        agentId: "agent-local",
        fetch: async () => Response.json(body),
      });
      await assert.rejects(adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)));
    }
  });

  test("maps authentication, rate-limit, and unavailable statuses without exposing bodies", async () => {
    const cases = [
      {
        status: 401,
        expected: { protocol_version: 1, status: "permanent_error", code: "unauthorized" },
      },
      {
        status: 429,
        headers: { "retry-after": "2" },
        expected: {
          protocol_version: 1,
          status: "retryable_error",
          code: "rate_limited",
          retry_after_ms: 2_000,
        },
      },
      {
        status: 503,
        expected: {
          protocol_version: 1,
          status: "retryable_error",
          code: "runtime_unavailable",
        },
      },
    ] as const;

    for (const scenario of cases) {
      const adapter = new OpenClawWebhookAdapter({
        url: URL,
        token: TOKEN,
        agentId: "agent-local",
        fetch: async () =>
          new Response(
            "private runtime diagnostic",
            "headers" in scenario
              ? { status: scenario.status, headers: scenario.headers }
              : { status: scenario.status },
          ),
      });
      assert.deepEqual(
        await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)),
        scenario.expected,
      );
    }
  });

  test("probes readiness without sending the hook token", async () => {
    const requests: Request[] = [];
    const adapter = new OpenClawWebhookAdapter({
      url: URL,
      token: TOKEN,
      agentId: "agent-local",
      fetch: async (input, init) => {
        requests.push(requestFrom(input, init));
        return new Response(null, { status: 204 });
      },
    });

    assert.deepEqual(await adapter.health(AbortSignal.timeout(1_000)), { healthy: true });
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [["GET", "http://127.0.0.1:18789/readyz"]],
    );
    assert.equal(requests[0]?.headers.has("authorization"), false);
  });
});
