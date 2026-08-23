import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { HermesWebhookAdapter } from "../src/adapters/hermes.js";
import type { FetchLike } from "../src/adapters/types.js";

const NOW_MS = Date.parse("2026-08-23T12:00:02Z");
const URL = "http://127.0.0.1:8644/webhooks/a2a";
const DELIVERY_ID = "delivery_01J6YP";
const SECRET = "hermes-binding-secret";

function requestFrom(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

function json(value: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function oversizedResponse(status: number): {
  response: Response;
  wasCancelled: () => boolean;
} {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls <= 16) {
            controller.enqueue(new Uint8Array(64 * 1024));
          } else if (pulls === 17) {
            controller.enqueue(new Uint8Array([0]));
          } else {
            controller.error(new Error("response was read past the size limit"));
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { status, headers: { "content-type": "application/json" } },
  );
  return { response, wasCancelled: () => cancelled };
}

describe("HermesWebhookAdapter", () => {
  test("sends only the delivery ID with Hermes V2 authentication", async () => {
    let captured: Request | undefined;
    const fetch: FetchLike = async (input, init) => {
      captured = requestFrom(input, init);
      return json(
        { status: "accepted", route: "a2a", event: "unknown", delivery_id: DELIVERY_ID },
        202,
      );
    };
    const adapter = new HermesWebhookAdapter({
      url: URL,
      secret: SECRET,
      fetch,
      now: () => NOW_MS,
    });

    assert.deepEqual(await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)), {
      protocol_version: 1,
      status: "accepted",
    });

    assert.ok(captured);
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, URL);
    assert.equal(captured.redirect, "error");
    assert.equal(captured.headers.get("x-request-id"), DELIVERY_ID);
    const body = await captured.text();
    assert.equal(body, `{"delivery_id":"${DELIVERY_ID}"}`);
    const timestamp = String(Math.floor(NOW_MS / 1_000));
    assert.equal(captured.headers.get("x-webhook-timestamp"), timestamp);
    assert.equal(
      captured.headers.get("x-webhook-signature-v2"),
      createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex"),
    );
  });

  test("normalizes Hermes duplicate acceptance", async () => {
    const adapter = new HermesWebhookAdapter({
      url: URL,
      secret: SECRET,
      fetch: async () => json({ status: "duplicate", delivery_id: DELIVERY_ID }, 200),
    });

    assert.deepEqual(await adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)), {
      protocol_version: 1,
      status: "duplicate",
    });
  });

  test("cancels an oversized success body while reading it", async () => {
    const oversized = oversizedResponse(202);
    const adapter = new HermesWebhookAdapter({
      url: URL,
      secret: SECRET,
      fetch: async () => oversized.response,
    });

    await assert.rejects(adapter.wake({ deliveryId: DELIVERY_ID }, AbortSignal.timeout(1_000)));
    assert.equal(oversized.wasCancelled(), true);
  });

  test("maps authentication, rate-limit, and unavailable statuses without reading their bodies", async () => {
    const cases = [
      {
        status: 401,
        expected: { protocol_version: 1, status: "permanent_error", code: "unauthorized" },
      },
      {
        status: 429,
        headers: { "retry-after": "5" },
        expected: {
          protocol_version: 1,
          status: "retryable_error",
          code: "rate_limited",
          retry_after_ms: 5_000,
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
      const adapter = new HermesWebhookAdapter({
        url: URL,
        secret: SECRET,
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

  test("uses the configured health endpoint", async () => {
    const requests: Request[] = [];
    const adapter = new HermesWebhookAdapter({
      url: URL,
      healthUrl: "http://127.0.0.1:8644/health",
      secret: SECRET,
      fetch: async (input, init) => {
        requests.push(requestFrom(input, init));
        return new Response(null, { status: 204 });
      },
    });

    assert.deepEqual(await adapter.health(AbortSignal.timeout(1_000)), { healthy: true });
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [["GET", "http://127.0.0.1:8644/health"]],
    );
    assert.equal(requests[0]?.redirect, "error");
  });
});
