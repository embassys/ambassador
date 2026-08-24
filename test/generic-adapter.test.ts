import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { GenericWebhookAdapter } from "../src/adapters/generic.js";
import type { FetchLike } from "../src/adapters/types.js";

const NOW_MS = Date.parse("2026-08-23T12:00:02Z");
const WEBHOOK_URL = "http://127.0.0.1:8644/webhooks/a2a";
const HEALTH_URL = "http://127.0.0.1:8644/health";
const SECRET = "binding-specific-test-secret";
const DELIVERY_ID = "delivery_01J6YP";

function asRequest(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GenericWebhookAdapter", () => {
  test("applies an internal wake deadline without aborting the caller signal", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    const adapter = new GenericWebhookAdapter({
      url: WEBHOOK_URL,
      secret: SECRET,
      wakeTimeoutMs: 5,
      fetch: async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      },
    });
    const operation = adapter.wake({ deliveryId: DELIVERY_ID }, caller.signal);
    const settled = operation.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(requestSignal);
      assert.notEqual(requestSignal, caller.signal);
      const result = await settled;
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error instanceof Error);
        assert.equal(result.error.name, "TimeoutError");
      }
      assert.equal(caller.signal.aborted, false);
    } finally {
      caller.abort();
      await settled;
    }
  });

  test("sends the exact content-blind wake body with a timestamp-bound HMAC", async () => {
    let captured: Request | undefined;
    const fetch: FetchLike = async (input, init) => {
      captured = asRequest(input, init);
      return jsonResponse({
        protocol_version: 1,
        status: "accepted",
        session_id: "local-session-42",
      });
    };
    const adapter = new GenericWebhookAdapter({
      url: WEBHOOK_URL,
      secret: SECRET,
      fetch,
      now: () => NOW_MS,
    });

    await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000));

    assert.ok(captured);
    assert.equal(captured.url, WEBHOOK_URL);
    assert.equal(captured.method, "POST");
    assert.equal(captured.headers.get("content-type"), "application/json");

    const body = await captured.text();
    assert.equal(
      body,
      '{"protocol_version":1,"delivery_id":"delivery_01J6YP","sent_at":"2026-08-23T12:00:02.000Z"}',
    );
    assert.deepEqual(Object.keys(JSON.parse(body) as Record<string, unknown>).sort(), [
      "delivery_id",
      "protocol_version",
      "sent_at",
    ]);

    const timestamp = String(Math.floor(NOW_MS / 1_000));
    const signature = createHmac("sha256", SECRET)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");
    assert.equal(captured.headers.get("x-webhook-timestamp"), timestamp);
    assert.equal(captured.headers.get("x-webhook-signature-v2"), signature);
  });

  for (const scenario of [
    {
      name: "accepted",
      wire: { protocol_version: 1, status: "accepted", session_id: "session-a" },
    },
    {
      name: "duplicate",
      wire: { protocol_version: 1, status: "duplicate", session_id: "session-a" },
    },
    {
      name: "retryable error",
      wire: {
        protocol_version: 1,
        status: "retryable_error",
        code: "rate_limited",
        retry_after_ms: 5_000,
      },
    },
    {
      name: "permanent error",
      wire: { protocol_version: 1, status: "permanent_error", code: "unauthorized" },
    },
  ] as const) {
    test(`strictly parses the ${scenario.name} response`, async () => {
      const adapter = new GenericWebhookAdapter({
        url: WEBHOOK_URL,
        secret: SECRET,
        now: () => NOW_MS,
        fetch: async () => jsonResponse(scenario.wire),
      });

      const result = await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000));

      assert.deepEqual(result, scenario.wire);
    });
  }

  test("rejects a response from a stale protocol version", async () => {
    const adapter = new GenericWebhookAdapter({
      url: WEBHOOK_URL,
      secret: SECRET,
      now: () => NOW_MS,
      fetch: async () => jsonResponse({ protocol_version: 0, status: "accepted" }),
    });

    await assert.rejects(adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)));
  });

  test("rejects malformed or non-strict response bodies", async (t) => {
    const bodies = [
      "not-json",
      JSON.stringify({ protocol_version: 1, status: "accepted", content: "forbidden" }),
      JSON.stringify({ protocol_version: 1, status: "retryable_error" }),
    ];

    for (const body of bodies) {
      await t.test(body, async () => {
        const adapter = new GenericWebhookAdapter({
          url: WEBHOOK_URL,
          secret: SECRET,
          now: () => NOW_MS,
          fetch: async () =>
            new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        });

        await assert.rejects(adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)));
      });
    }
  });

  test("reports health from the configured health endpoint", async () => {
    const requests: Request[] = [];
    const statuses = [204, 503];
    const adapter = new GenericWebhookAdapter({
      url: WEBHOOK_URL,
      healthUrl: HEALTH_URL,
      secret: SECRET,
      now: () => NOW_MS,
      fetch: async (input, init) => {
        requests.push(asRequest(input, init));
        const status = statuses.shift();
        assert.ok(status);
        return new Response(null, { status });
      },
    });

    assert.deepEqual(await adapter.health(AbortSignal.timeout(1_000)), { healthy: true });
    assert.equal((await adapter.health(AbortSignal.timeout(1_000))).healthy, false);
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", HEALTH_URL],
        ["GET", HEALTH_URL],
      ],
    );
  });
});
