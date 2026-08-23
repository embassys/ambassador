import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FetchLike } from "../src/adapters/types.js";
import { HttpControllerClient } from "../src/controller.js";
import type { PersistenceAcknowledgement, PollResponse, WakeReport } from "../src/protocol.js";

const BASE_URL = "https://controller.example";
const TOKEN = "installation-test-token";

const VALID_POLL: PollResponse = {
  protocol_version: 1,
  cursor: "cursor_01J6YR",
  server_time: "2026-08-23T12:00:00Z",
  notifications: [
    {
      notification_id: "notice_01J6YR",
      delivery_id: "delivery_01J6YP",
      binding_id: "binding_generic",
      issued_at: "2026-08-23T11:59:58Z",
      expires_at: "2026-08-23T12:09:58Z",
    },
  ],
};

const ACKNOWLEDGEMENT: PersistenceAcknowledgement = {
  protocol_version: 1,
  notification_id: "notice_01J6YR",
  delivery_id: "delivery_01J6YP",
  status: "persisted",
  persisted_at: "2026-08-23T12:00:01Z",
};

const REPORT: WakeReport = {
  protocol_version: 1,
  report_id: "report_01J6YS",
  sequence: 1,
  notification_id: "notice_01J6YR",
  delivery_id: "delivery_01J6YP",
  status: "accepted",
  observed_at: "2026-08-23T12:00:02Z",
};

function asRequest(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

function createClient(fetch: FetchLike): HttpControllerClient {
  return new HttpControllerClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    waitSeconds: 30,
    maxNotifications: 50,
    fetch,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpControllerClient", () => {
  test("uses the fixed poll path and query parameters with bearer authentication", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      requests.push(asRequest(input, init));
      return jsonResponse(VALID_POLL);
    });

    assert.deepEqual(await client.poll(null, AbortSignal.timeout(1_000)), VALID_POLL);
    await client.poll("cursor_01J6YQ", AbortSignal.timeout(1_000));

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
      const url = new URL(request.url);
      assert.equal(url.origin, BASE_URL);
      assert.equal(url.pathname, "/v1/sidecar/notifications");
      assert.equal(url.searchParams.get("wait_seconds"), "30");
      assert.equal(url.searchParams.get("max_notifications"), "50");
    }
    assert.equal(new URL(requests[0]?.url ?? "").searchParams.has("cursor"), false);
    assert.equal(new URL(requests[1]?.url ?? "").searchParams.get("cursor"), "cursor_01J6YQ");
    assert.deepEqual([...new URL(requests[1]?.url ?? "").searchParams.keys()].sort(), [
      "cursor",
      "max_notifications",
      "wait_seconds",
    ]);
  });

  test("uses fixed acknowledgement and report paths with exact JSON bodies", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      requests.push(asRequest(input, init));
      return new Response(null, { status: requests.length === 1 ? 204 : 208 });
    });

    await client.acknowledge(ACKNOWLEDGEMENT, AbortSignal.timeout(1_000));
    await client.report(REPORT, AbortSignal.timeout(1_000));

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(
      new URL(requests[0]?.url ?? "").pathname,
      "/v1/sidecar/notifications/notice_01J6YR/ack",
    );
    assert.equal(requests[1]?.method, "POST");
    assert.equal(new URL(requests[1]?.url ?? "").pathname, "/v1/sidecar/wake-reports");
    for (const request of requests) {
      assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(request.headers.get("content-type"), "application/json");
    }
    assert.deepEqual(JSON.parse((await requests[0]?.text()) ?? "null"), ACKNOWLEDGEMENT);
    assert.deepEqual(JSON.parse((await requests[1]?.text()) ?? "null"), REPORT);
  });

  test("strictly rejects invalid poll messages", async (t) => {
    const invalidResponses: Record<string, unknown>[] = [
      { ...VALID_POLL, protocol_version: 2 },
      { ...VALID_POLL, task: "content must never cross this boundary" },
      { ...VALID_POLL, unknown: true },
      { ...VALID_POLL, cursor: "contains spaces" },
      { ...VALID_POLL, server_time: "2026-08-23T12:00:00+00:00" },
      {
        ...VALID_POLL,
        notifications: [{ ...VALID_POLL.notifications[0], prompt: "forbidden" }],
      },
    ];

    for (const response of invalidResponses) {
      await t.test(JSON.stringify(response), async () => {
        const client = createClient(async () => jsonResponse(response));
        await assert.rejects(client.poll(null, AbortSignal.timeout(1_000)));
      });
    }
  });

  test("rejects malformed JSON poll responses", async () => {
    const client = createClient(
      async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await assert.rejects(client.poll(null, AbortSignal.timeout(1_000)));
  });

  test("bounds response bodies and does not expose raw controller content", async (t) => {
    const sensitive = "raw-controller-response-must-not-be-logged";
    const logged: unknown[][] = [];
    t.mock.method(console, "log", (...args: unknown[]) => logged.push(args));
    t.mock.method(console, "warn", (...args: unknown[]) => logged.push(args));
    t.mock.method(console, "error", (...args: unknown[]) => logged.push(args));

    const oversizedClient = createClient(
      async () =>
        new Response(`${sensitive}${"x".repeat(2 * 1024 * 1024)}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await assert.rejects(
      oversizedClient.poll(null, AbortSignal.timeout(1_000)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(sensitive));
        return true;
      },
    );

    const failedStatusClient = createClient(
      async () => new Response(sensitive, { status: 503, statusText: "Service Unavailable" }),
    );
    await assert.rejects(
      failedStatusClient.poll(null, AbortSignal.timeout(1_000)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(sensitive));
        return true;
      },
    );

    assert.equal(
      logged.flat().some((value) => String(value).includes(sensitive)),
      false,
    );
  });

  test("rejects non-success statuses for acknowledgement and report calls", async () => {
    const sensitive = "do-not-reflect-this-response";
    const client = createClient(async () => new Response(sensitive, { status: 500 }));

    await assert.rejects(
      client.acknowledge(ACKNOWLEDGEMENT, AbortSignal.timeout(1_000)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(sensitive));
        return true;
      },
    );
    await assert.rejects(client.report(REPORT, AbortSignal.timeout(1_000)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(sensitive));
      return true;
    });
  });
});
