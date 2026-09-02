import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import type { CentralMessage } from "../src/central-rest.js";
import { WebhookDeliveryError, WebhookDeliveryTarget } from "../src/webhook-delivery.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  action_type_id: "get_email",
  payload: { reason: "complete body marker" },
  created_at: "2026-09-02T12:00:00Z",
};

test("sends the exact canonical message with bearer and HMAC V2 authentication", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const target = new WebhookDeliveryTarget({
    url: "https://agent.example.test/embassys",
    secret: SECRET,
    now: () => 1_788_364_800_000,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(await target.deliver(MESSAGE, new AbortController().signal), {
    status: "accepted",
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  const body = JSON.stringify(MESSAGE);
  const headers = new Headers(request.init.headers);
  assert.equal(request.url, "https://agent.example.test/embassys");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.body, body);
  assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
  assert.equal(headers.get("idempotency-key"), MESSAGE.id);
  assert.equal(headers.get("x-request-id"), MESSAGE.id);
  assert.equal(headers.get("x-webhook-timestamp"), "1788364800");
  assert.equal(
    headers.get("x-webhook-signature-v2"),
    createHmac("sha256", SECRET).update(`1788364800.${body}`).digest("hex"),
  );
});

test("retries bounded pre-acceptance failures with one idempotency key", async () => {
  const ids: string[] = [];
  let attempts = 0;
  const target = new WebhookDeliveryTarget({
    url: "http://127.0.0.1:18789/embassys",
    secret: SECRET,
    maximumAttempts: 3,
    retryDelayMs: 1,
    deadlineMs: 500,
    fetch: async (_input, init) => {
      attempts += 1;
      ids.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (attempts === 1) throw new Error("private transport detail");
      return new Response(null, { status: attempts === 2 ? 503 : 202 });
    },
  });
  assert.deepEqual(await target.deliver(MESSAGE, new AbortController().signal), {
    status: "accepted",
  });
  assert.equal(attempts, 3);
  assert.deepEqual(ids, ["message-1", "message-1", "message-1"]);
});

test("accepts HTTPS and literal-loopback HTTP only", () => {
  for (const url of [
    "http://example.test/hook",
    "http://localhost:18789/hook",
    "ftp://127.0.0.1/hook",
    "https://user:password@example.test/hook",
    "https://example.test/hook#fragment",
    "https://example.test/hook\nsecond",
  ]) {
    assert.throws(
      () => new WebhookDeliveryTarget({ url, secret: SECRET }),
      (error: unknown) =>
        error instanceof WebhookDeliveryError && error.code === "invalid_configuration",
    );
  }
  assert.doesNotThrow(
    () => new WebhookDeliveryTarget({ url: "https://example.test/hook", secret: SECRET }),
  );
  assert.doesNotThrow(
    () => new WebhookDeliveryTarget({ url: "http://[::1]:8788/hook", secret: SECRET }),
  );
});

test("rejects oversized bodies before dispatch and aborts active delivery on close", async () => {
  let calls = 0;
  const oversized = new WebhookDeliveryTarget({
    url: "https://example.test/hook",
    secret: SECRET,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    oversized.deliver(
      { ...MESSAGE, payload: { value: "x".repeat(512 * 1024) } },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof WebhookDeliveryError && error.code === "delivery_failed",
  );
  assert.equal(calls, 0);

  const active = new WebhookDeliveryTarget({
    url: "https://example.test/hook",
    secret: SECRET,
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });
  const running = active.deliver(MESSAGE, new AbortController().signal);
  await active.close();
  await assert.rejects(
    running,
    (error: unknown) => error instanceof WebhookDeliveryError && error.code === "delivery_failed",
  );
});
