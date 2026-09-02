import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import type { CentralMessage } from "../src/central-rest.js";
import { NotificationJournal } from "../src/notification-journal.js";
import {
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "../src/notification-relay.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const WEBHOOK_URL = "http://127.0.0.1:18789/hooks/agent";
const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  action_type_id: "get_email",
  payload: { reason: "private message body" },
  created_at: "2026-08-27T12:00:00Z",
};

function journal(t: TestContext): NotificationJournal {
  const directory = mkdtempSync(join(tmpdir(), "a2a-relay-current-"));
  const value = new NotificationJournal(join(directory, "notifications.sqlite3"));
  t.after(() => {
    value.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return value;
}

function pending(signal: AbortSignal): Promise<readonly CentralMessage[]> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function options(
  value: NotificationJournal,
  receiveMessages: (signal: AbortSignal) => Promise<readonly CentralMessage[]>,
  webhookFetch: typeof fetch,
) {
  return {
    journal: value,
    webhookUrl: WEBHOOK_URL,
    webhookToken: WEBHOOK_TOKEN,
    receiveMessages,
    fetch: webhookFetch,
    now: () => NOW,
    random: () => 0,
    idleIntervalMs: 5,
    emptyPollRetryMs: 5,
    retryBaseMs: 5,
    retryCapMs: 10,
  };
}

test("holds a consumed body in memory, journals only its ID, wakes, and removes it after ack", async (t) => {
  const value = journal(t);
  const controller = new AbortController();
  let polls = 0;
  let wakes = 0;
  let webhookBody = "";
  const receive = async (signal: AbortSignal): Promise<readonly CentralMessage[]> => {
    polls += 1;
    if (polls === 1) return [MESSAGE];
    return pending(signal);
  };
  const webhookFetch: typeof fetch = async (_input, init) => {
    wakes += 1;
    webhookBody = String(init?.body);
    const headers = new Headers(init?.headers);
    const timestamp = String(Math.floor(NOW / 1_000));
    assert.equal(headers.get("authorization"), `Bearer ${WEBHOOK_TOKEN}`);
    assert.equal(headers.get("idempotency-key"), MESSAGE.id);
    assert.equal(
      headers.get("x-webhook-signature-v2"),
      createHmac("sha256", WEBHOOK_TOKEN)
        .update(timestamp)
        .update(".")
        .update(webhookBody)
        .digest("hex"),
    );
    return new Response(null, { status: 202 });
  };
  const relay = new NotificationRelay(options(value, receive, webhookFetch));
  const running = relay.run(controller.signal);
  await waitFor(() => wakes === 1);
  assert.equal(webhookBody.includes("private message body"), false);
  assert.equal(value.get("message-1")?.messageId, "message-1");
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
    messages: [MESSAGE],
  });
  assert.equal(relay.confirmAcknowledgement("message-1"), true);
  assert.equal(value.get("message-1"), undefined);
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), { messages: [] });
  controller.abort();
  await running;
});

test("does not poll central again until every consumed body leaves memory", async (t) => {
  const value = journal(t);
  const controller = new AbortController();
  let polls = 0;
  const receive = async (signal: AbortSignal): Promise<readonly CentralMessage[]> => {
    polls += 1;
    if (polls === 1) return [MESSAGE];
    return pending(signal);
  };
  const relay = new NotificationRelay(
    options(value, receive, async () => new Response(null, { status: 202 })),
  );
  const running = relay.run(controller.signal);
  await waitFor(() => value.count() === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(polls, 1);
  relay.confirmAcknowledgement("message-1");
  await waitFor(() => polls === 2);
  controller.abort();
  await running;
});

test("ID-less messages are distinct volatile deliveries and are returned once", async (t) => {
  const value = journal(t);
  const controller = new AbortController();
  let polls = 0;
  const { id: _discardedId, ...message } = MESSAGE;
  const receive = async (signal: AbortSignal): Promise<readonly CentralMessage[]> => {
    polls += 1;
    if (polls === 1) return [message, message];
    return pending(signal);
  };
  const wakeKeys = new Set<string>();
  const relay = new NotificationRelay(
    options(value, receive, async (_input, init) => {
      wakeKeys.add(new Headers(init?.headers).get("idempotency-key") ?? "");
      return new Response(null, { status: 202 });
    }),
  );
  const running = relay.run(controller.signal);
  await waitFor(() => wakeKeys.size === 2);
  assert.equal(value.count(), 0);
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
    messages: [message, message],
  });
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), { messages: [] });
  controller.abort();
  await running;
});

test("discards unrecoverable journal IDs on restart and never invents body recovery", async (t) => {
  const value = journal(t);
  value.ingest(["consumed-before-crash"], NOW);
  const controller = new AbortController();
  const relay = new NotificationRelay(
    options(value, pending, async () => new Response(null, { status: 202 })),
  );
  const running = relay.run(controller.signal);
  await waitFor(() => value.count() === 0);
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), { messages: [] });
  controller.abort();
  await running;
});

test("retries transient receive failures and fails closed on oversized batches", async (t) => {
  const value = journal(t);
  const controller = new AbortController();
  let attempts = 0;
  const relay = new NotificationRelay(
    options(
      value,
      async (signal) => {
        attempts += 1;
        if (attempts === 1) throw new RetryableNotificationReceiveError(1);
        if (attempts === 2) return [];
        return pending(signal);
      },
      async () => new Response(null, { status: 202 }),
    ),
  );
  const running = relay.run(controller.signal);
  await waitFor(() => attempts >= 3);
  controller.abort();
  await running;

  const invalid = new NotificationRelay(
    options(
      value,
      async () => Array.from({ length: 257 }, (_, index) => ({ ...MESSAGE, id: `m-${index}` })),
      async () => new Response(null, { status: 202 }),
    ),
  );
  await assert.rejects(
    invalid.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "invalid_notification_response",
  );
});
