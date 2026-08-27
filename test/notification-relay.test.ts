import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { NotificationJournal } from "../src/notification-journal.js";
import {
  type NotificationFetch,
  NotificationRelay,
  NotificationRelayError,
} from "../src/notification-relay.js";

const NOW_MS = Date.parse("2026-08-27T12:00:00Z");
const MESSAGE_ID = "0f56d6f4-6073-4f75-9f31-72d7d760271a";
const MESSAGE_CONTENT = "private task body";
const CENTRAL_URL = "https://central.invalid/base";
const WEBHOOK_URL = "http://127.0.0.1:18789/hooks/agent";
const CENTRAL_TOKEN = "central-secret-token";
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_RESULT_BYTES = 512 * 1024;
const MAX_MESSAGES_PER_POLL = 256;

function temporaryJournal(t: TestContext): NotificationJournal {
  const directory = mkdtempSync(join(tmpdir(), "a2a-notification-relay-test-"));
  const journal = new NotificationJournal(join(directory, "notifications.sqlite"));
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return journal;
}

function pendingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function relayOptions(journal: NotificationJournal, request: NotificationFetch) {
  return {
    journal,
    centralApiUrl: CENTRAL_URL,
    centralToken: CENTRAL_TOKEN,
    webhookUrl: WEBHOOK_URL,
    webhookToken: WEBHOOK_TOKEN,
    fetch: request,
    now: () => NOW_MS,
    random: () => 0,
    idleIntervalMs: 5,
    pollRetryMs: 5,
  };
}

function fullMessage(id: string = MESSAGE_ID): Record<string, unknown> {
  return {
    id,
    sender_agent_id: "agent_sender",
    action_type_id: "action_calendar",
    payload: { content: MESSAGE_CONTENT },
    created_at: "2026-08-27T12:00:00Z",
  };
}

test("buffers the consuming REST response before waking and serves it until ack_message", async (t) => {
  const journal = temporaryJournal(t);
  const controller = new AbortController();
  let polls = 0;
  let wakes = 0;
  const message = fullMessage();
  const request: NotificationFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname === "/api/poll_messages") {
      polls += 1;
      assert.equal(url.toString(), "https://central.invalid/api/poll_messages?timeout=30");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(headers.get("authorization"), `Bearer ${CENTRAL_TOKEN}`);
      if (polls === 1) return new Response(JSON.stringify({ messages: [message] }));
      return pendingResponse(init.signal);
    }

    assert.equal(url.toString(), WEBHOOK_URL);
    assert.ok(journal.get(MESSAGE_ID));
    assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
      messages: [message],
    });
    const body = String(init.body);
    const timestamp = String(Math.floor(NOW_MS / 1_000));
    assert.equal(headers.get("authorization"), `Bearer ${WEBHOOK_TOKEN}`);
    assert.equal(headers.get("idempotency-key"), MESSAGE_ID);
    assert.equal(headers.get("x-request-id"), MESSAGE_ID);
    assert.equal(headers.get("x-webhook-timestamp"), timestamp);
    assert.equal(
      headers.get("x-webhook-signature-v2"),
      createHmac("sha256", WEBHOOK_TOKEN).update(timestamp).update(".").update(body).digest("hex"),
    );
    wakes += 1;
    return new Response(null, { status: 202 });
  };

  const relay = new NotificationRelay(relayOptions(journal, request));
  const running = relay.run(controller.signal);
  await waitFor(() => wakes === 1);
  assert.equal(polls, 1, "the consuming poll continued before the inbox drained");
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
    messages: [message],
  });
  assert.equal(relay.confirmContentAcknowledgement(MESSAGE_ID), true);
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), { messages: [] });
  await waitFor(() => polls === 2);
  controller.abort();
  await running;
});

test("treats ID-less messages as distinct volatile one-shot deliveries", async (t) => {
  const journal = temporaryJournal(t);
  const controller = new AbortController();
  let polls = 0;
  const wakeKeys: string[] = [];
  const message = { payload: { content: MESSAGE_CONTENT } };
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ messages: [message, message] }));
      return pendingResponse(init.signal);
    }
    const headers = new Headers(init.headers);
    const key = headers.get("idempotency-key");
    assert.ok(key);
    assert.equal(headers.get("x-request-id"), key);
    assert.match(key, /^[A-Za-z0-9._~-]+$/u);
    assert.deepEqual(JSON.parse(String(init.body)), {
      message: "An A2A message is ready. Use the A2A MCP tools to retrieve and process it.",
      name: "A2A Gateway",
      deliver: false,
      wakeMode: "now",
    });
    wakeKeys.push(key);
    return new Response(null, { status: 202 });
  };
  const relay = new NotificationRelay(relayOptions(journal, request));
  const running = relay.run(controller.signal);

  await waitFor(() => wakeKeys.length === 2);
  assert.notEqual(wakeKeys[0], wakeKeys[1]);
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
    messages: [message, message],
  });
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), { messages: [] });
  await waitFor(() => polls === 2);
  for (const key of wakeKeys) assert.equal(journal.get(key), undefined);
  controller.abort();
  await running;
});

test("validates the complete full-message response before changing durable state", async (t) => {
  const journal = temporaryJournal(t);
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname !== "/api/poll_messages") return pendingResponse(init.signal);
    return new Response(
      JSON.stringify({
        messages: [fullMessage(), { ...fullMessage("message-2"), token: CENTRAL_TOKEN }],
      }),
    );
  };
  const relay = new NotificationRelay(relayOptions(journal, request));

  await assert.rejects(relay.run(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof NotificationRelayError);
    assert.equal(error.code, "invalid_notification_response");
    assert.equal(error.message.includes(MESSAGE_CONTENT), false);
    assert.equal(error.message.includes(CENTRAL_URL), false);
    assert.equal(error.message.includes(CENTRAL_TOKEN), false);
    return true;
  });
  assert.equal(journal.get(MESSAGE_ID), undefined);
  assert.equal(journal.get("message-2"), undefined);
});

test("rejects conflicting duplicate IDs before buffering or waking", async (t) => {
  const journal = temporaryJournal(t);
  let wakeAttempted = false;
  const request: NotificationFetch = async (url) => {
    if (url.pathname !== "/api/poll_messages") {
      wakeAttempted = true;
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        messages: [fullMessage(), { ...fullMessage(), payload: { content: "changed" } }],
      }),
    );
  };
  const relay = new NotificationRelay(relayOptions(journal, request));

  await assert.rejects(
    relay.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "invalid_notification_response",
  );
  assert.equal(journal.get(MESSAGE_ID), undefined);
  assert.equal(wakeAttempted, false);
});

test("accepts a response at 4 MiB and rejects one byte above it", async (t) => {
  const acceptedJournal = temporaryJournal(t);
  const acceptedController = new AbortController();
  const json = '{"messages":[]}';
  const boundaryBody = `${json}${" ".repeat(MAX_RESPONSE_BYTES - json.length)}`;
  let acceptedPolls = 0;
  const acceptedFetch: NotificationFetch = async (url, init) => {
    if (url.pathname !== "/api/poll_messages") return new Response(null, { status: 204 });
    acceptedPolls += 1;
    if (acceptedPolls === 1) return new Response(boundaryBody);
    return pendingResponse(init.signal);
  };
  const acceptedRelay = new NotificationRelay(relayOptions(acceptedJournal, acceptedFetch));
  const acceptedRun = acceptedRelay.run(acceptedController.signal);
  await waitFor(() => acceptedPolls === 2);
  acceptedController.abort();
  await acceptedRun;

  const rejectedJournal = temporaryJournal(t);
  const oversizedFetch: NotificationFetch = async () =>
    new Response("x".repeat(MAX_RESPONSE_BYTES + 1));
  const rejectedRelay = new NotificationRelay(relayOptions(rejectedJournal, oversizedFetch));
  await assert.rejects(
    rejectedRelay.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "notification_response_too_large",
  );
});

test("accepts a 512 KiB normalized result and rejects one byte above it", async (t) => {
  const emptyResultBytes = Buffer.byteLength(JSON.stringify({ messages: [{ content: "" }] }));
  const boundaryContent = "x".repeat(MAX_BUFFERED_RESULT_BYTES - emptyResultBytes);
  const boundaryResult = { messages: [{ content: boundaryContent }] };
  assert.equal(Buffer.byteLength(JSON.stringify(boundaryResult)), MAX_BUFFERED_RESULT_BYTES);

  const acceptedJournal = temporaryJournal(t);
  const acceptedController = new AbortController();
  let acceptedPolls = 0;
  let wakes = 0;
  const acceptedFetch: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      acceptedPolls += 1;
      if (acceptedPolls === 1) return new Response(JSON.stringify(boundaryResult));
      return pendingResponse(init.signal);
    }
    wakes += 1;
    return new Response(null, { status: 202 });
  };
  const acceptedRelay = new NotificationRelay(relayOptions(acceptedJournal, acceptedFetch));
  const acceptedRun = acceptedRelay.run(acceptedController.signal);
  await waitFor(() => wakes === 1);
  assert.deepEqual(
    await acceptedRelay.pollMessages(0, new AbortController().signal),
    boundaryResult,
  );
  acceptedController.abort();
  await acceptedRun;

  const rejectedJournal = temporaryJournal(t);
  const rejectedFetch: NotificationFetch = async () =>
    new Response(JSON.stringify({ messages: [{ content: `${boundaryContent}x` }] }));
  const rejectedRelay = new NotificationRelay(relayOptions(rejectedJournal, rejectedFetch));
  await assert.rejects(
    rejectedRelay.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "notification_response_too_large",
  );
});

test("accepts message and structural limits and rejects one above them", async (t) => {
  const acceptedBatches = [
    Array.from({ length: MAX_MESSAGES_PER_POLL }, () => ({})),
    [{ payload: Array.from({ length: 16_373 }, () => 0) }],
  ];
  for (const messages of acceptedBatches) {
    const journal = temporaryJournal(t);
    const controller = new AbortController();
    let polls = 0;
    let wakeAttempted = false;
    const request: NotificationFetch = async (url, init) => {
      if (url.pathname === "/api/poll_messages") {
        polls += 1;
        if (polls === 1) return new Response(JSON.stringify({ messages }));
        return pendingResponse(init.signal);
      }
      wakeAttempted = true;
      return new Response(null, { status: 202 });
    };
    const relay = new NotificationRelay(relayOptions(journal, request));
    const running = relay.run(controller.signal);
    await waitFor(() => wakeAttempted);
    controller.abort();
    await running;
  }

  const rejectedBatches = [
    Array.from({ length: MAX_MESSAGES_PER_POLL + 1 }, () => ({})),
    [{ payload: Array.from({ length: 16_374 }, () => 0) }],
  ];
  for (const messages of rejectedBatches) {
    const journal = temporaryJournal(t);
    let wakeAttempted = false;
    const request: NotificationFetch = async (url) => {
      if (url.pathname === "/api/poll_messages") {
        return new Response(JSON.stringify({ messages }));
      }
      wakeAttempted = true;
      return new Response(null, { status: 202 });
    };
    const relay = new NotificationRelay(relayOptions(journal, request));
    await assert.rejects(
      relay.run(new AbortController().signal),
      (error: unknown) =>
        error instanceof NotificationRelayError && error.code === "invalid_notification_response",
    );
    assert.equal(wakeAttempted, false);
  }
});

test("accepts 100 JSON levels and rejects level 101 before changing state", async (t) => {
  const nestedResponse = (payloadLevels: number): string =>
    `{"messages":[{"payload":${"[".repeat(payloadLevels)}null${"]".repeat(payloadLevels)}}]}`;

  const acceptedJournal = temporaryJournal(t);
  const acceptedController = new AbortController();
  let acceptedPolls = 0;
  let acceptedWake = false;
  const acceptedFetch: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      acceptedPolls += 1;
      if (acceptedPolls === 1) return new Response(nestedResponse(97));
      return pendingResponse(init.signal);
    }
    acceptedWake = true;
    return new Response(null, { status: 202 });
  };
  const acceptedRelay = new NotificationRelay(relayOptions(acceptedJournal, acceptedFetch));
  const acceptedRun = acceptedRelay.run(acceptedController.signal);
  await waitFor(() => acceptedWake);
  acceptedController.abort();
  await acceptedRun;

  const rejectedJournal = temporaryJournal(t);
  const rejectedFetch: NotificationFetch = async () => new Response(nestedResponse(98));
  const rejectedRelay = new NotificationRelay(relayOptions(rejectedJournal, rejectedFetch));
  await assert.rejects(
    rejectedRelay.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "invalid_notification_response",
  );
});

test("keeps retrying an ID-less wake when local polling wins the in-flight race", async (t) => {
  const journal = temporaryJournal(t);
  const controller = new AbortController();
  let polls = 0;
  let wakeAttempts = 0;
  const wakeKeys: string[] = [];
  let rejectFirstWake: ((reason: Error) => void) | undefined;
  let resolveSecondWake: ((response: Response) => void) | undefined;
  let resolveFirstWake: (() => void) | undefined;
  const firstWakeStarted = new Promise<void>((resolve) => {
    resolveFirstWake = resolve;
  });
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ messages: [{ content: MESSAGE_CONTENT }] }));
      }
      return pendingResponse(init.signal);
    }
    wakeAttempts += 1;
    const wakeKey = new Headers(init.headers).get("idempotency-key");
    assert.ok(wakeKey);
    assert.equal(new Headers(init.headers).get("x-request-id"), wakeKey);
    wakeKeys.push(wakeKey);
    if (wakeAttempts === 1) {
      resolveFirstWake?.();
      return await new Promise<Response>((_, reject) => {
        rejectFirstWake = reject;
      });
    }
    return await new Promise<Response>((resolve) => {
      resolveSecondWake = resolve;
    });
  };
  const relay = new NotificationRelay({
    ...relayOptions(journal, request),
    now: Date.now,
    retryBaseMs: 2,
    retryCapMs: 2,
    idleIntervalMs: 1,
  });
  const running = relay.run(controller.signal);

  await firstWakeStarted;
  assert.deepEqual(await relay.pollMessages(0, new AbortController().signal), {
    messages: [{ content: MESSAGE_CONTENT }],
  });
  rejectFirstWake?.(new Error("uncertain wake"));
  await waitFor(() => wakeAttempts === 2);
  assert.deepEqual(wakeKeys, [wakeKeys[0], wakeKeys[0]]);
  assert.equal(polls, 1, "central polling resumed before the volatile wake was accepted");
  resolveSecondWake?.(new Response(null, { status: 202 }));
  await waitFor(() => polls === 2);
  controller.abort();
  await running;
});

for (const scenario of [
  { name: "failed", response: () => new Response(null, { status: 503 }), uncertain: false },
  {
    name: "uncertain",
    response: () => Promise.reject(new Error("must not escape: URL, headers, body, token")),
    uncertain: true,
  },
] as const) {
  test(`schedules an equal-jitter retry after the ${scenario.name} wake outcome`, async (t) => {
    const journal = temporaryJournal(t);
    const controller = new AbortController();
    let polls = 0;
    const request: NotificationFetch = async (url, init) => {
      if (url.pathname === "/api/poll_messages") {
        polls += 1;
        if (polls === 1) return new Response(JSON.stringify({ messages: [fullMessage()] }));
        return pendingResponse(init.signal);
      }
      return scenario.response();
    };
    const relay = new NotificationRelay(relayOptions(journal, request));
    const running = relay.run(controller.signal);

    await waitFor(() => journal.get(MESSAGE_ID)?.wakeState === "retry_wait");
    const record = journal.get(MESSAGE_ID);
    assert.equal(record?.wakeAttemptCount, 1);
    assert.equal(record?.wakeNextAttemptAtMs, NOW_MS + 500);
    assert.equal(record?.wakeMayHaveReachedWebhook, scenario.uncertain);
    controller.abort();
    await running;
  });
}

test("redrives an accepted ID-bearing wake until confirmed content acknowledgement", async (t) => {
  const journal = temporaryJournal(t);
  let polls = 0;
  let wakes = 0;
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ messages: [fullMessage()] }));
      return pendingResponse(init.signal);
    }
    wakes += 1;
    return new Response(null, { status: 202 });
  };
  const relay = new NotificationRelay({
    ...relayOptions(journal, request),
    now: Date.now,
    acceptedRedriveMs: 10,
    idleIntervalMs: 2,
  });
  const running = relay.run(new AbortController().signal);

  await waitFor(() => wakes >= 2);
  assert.equal(relay.confirmContentAcknowledgement(MESSAGE_ID), true);
  await waitFor(() => journal.get(MESSAGE_ID)?.wakeState === "content_acknowledged");
  const wakeCountAtAcknowledgement = wakes;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(wakes, wakeCountAtAcknowledgement);
  await relay.shutdown();
  await running;
});

test("discards durable wakes whose consuming message body was lost on restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-notification-restart-test-"));
  const path = join(directory, "notifications.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let journal = new NotificationJournal(path);
  journal.ingest([MESSAGE_ID], Date.now());
  journal.close();

  journal = new NotificationJournal(path);
  t.after(() => journal.close());
  let wakes = 0;
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") return pendingResponse(init.signal);
    wakes += 1;
    return new Response(null, { status: 202 });
  };
  const relay = new NotificationRelay({
    ...relayOptions(journal, request),
    now: Date.now,
    idleIntervalMs: 1,
  });
  const running = relay.run(new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wakes, 0);
  assert.equal(journal.get(MESSAGE_ID), undefined);
  await relay.shutdown();
  await running;
});

test("combines request deadlines with shutdown cancellation and rejects redirects", async (t) => {
  const deadlineJournal = temporaryJournal(t);
  let deadlinePolls = 0;
  const deadlineFetch: NotificationFetch = async (_url, init) => {
    deadlinePolls += 1;
    assert.equal(init.redirect, "manual");
    return pendingResponse(init.signal);
  };
  const deadlineRelay = new NotificationRelay({
    ...relayOptions(deadlineJournal, deadlineFetch),
    pollDeadlineMs: 2,
    pollRetryMs: 1,
  });
  const deadlineRun = deadlineRelay.run(new AbortController().signal);
  await waitFor(() => deadlinePolls >= 2);
  await deadlineRelay.shutdown();
  await deadlineRun;

  const redirectJournal = temporaryJournal(t);
  const redirectFetch: NotificationFetch = async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://must-not-be-followed.invalid/with-secret" },
    });
  };
  const redirectRelay = new NotificationRelay(relayOptions(redirectJournal, redirectFetch));
  await assert.rejects(redirectRelay.run(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof NotificationRelayError);
    assert.equal(error.code, "central_redirect_rejected");
    assert.equal(error.message.includes("must-not-be-followed"), false);
    return true;
  });
});
