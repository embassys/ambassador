import assert from "node:assert/strict";
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

const NOW_MS = Date.parse("2026-08-25T12:00:00Z");
const MESSAGE_ID = "0f56d6f4-6073-4f75-9f31-72d7d760271a";
const CENTRAL_URL = "https://central.invalid/base";
const WEBHOOK_URL = "http://127.0.0.1:18789/hooks/agent";
const CENTRAL_TOKEN = "central-secret-token";
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

test("persists before independently sending exact notification ack and OpenClaw wake", async (t) => {
  const journal = temporaryJournal(t);
  const controller = new AbortController();
  let pollCount = 0;
  let wakeCount = 0;
  let releaseAcknowledgement: (() => void) | undefined;
  const trace: string[] = [];

  const request: NotificationFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname === "/api/poll_messages") {
      pollCount += 1;
      assert.equal(url.toString(), "https://central.invalid/api/poll_messages?timeout=30&view=ids");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(headers.get("authorization"), `Bearer ${CENTRAL_TOKEN}`);
      if (pollCount === 1) {
        return new Response(JSON.stringify({ messages: [{ id: MESSAGE_ID }, { id: MESSAGE_ID }] }));
      }
      return pendingResponse(init.signal);
    }

    const persisted = journal.get(MESSAGE_ID);
    assert.ok(persisted);
    trace.push(url.pathname === "/api/ack_notification" ? "ack-after-commit" : "wake-after-commit");

    if (url.pathname === "/api/ack_notification") {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(headers.get("authorization"), `Bearer ${CENTRAL_TOKEN}`);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(init.body, `{"message_id":"${MESSAGE_ID}"}`);
      await new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      return new Response(null, { status: 204 });
    }

    assert.equal(url.toString(), WEBHOOK_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(headers.get("authorization"), `Bearer ${WEBHOOK_TOKEN}`);
    assert.equal(headers.get("idempotency-key"), MESSAGE_ID);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), {
      message: `A2A message ${MESSAGE_ID} is ready. Use the A2A MCP tools to retrieve and process it.`,
      name: "A2A Gateway",
      deliver: false,
      wakeMode: "now",
    });
    assert.equal(String(init.body).includes("agentId"), false);
    wakeCount += 1;
    return new Response(null, { status: 202 });
  };

  const relay = new NotificationRelay(relayOptions(journal, request));
  const running = relay.run(controller.signal);
  await waitFor(() => wakeCount === 1);
  assert.equal(journal.get(MESSAGE_ID)?.notificationAcknowledgementState, "in_flight");
  assert.equal(journal.get(MESSAGE_ID)?.wakeState, "accepted_wait");
  releaseAcknowledgement?.();
  await waitFor(() => journal.get(MESSAGE_ID)?.notificationAcknowledgementState === "confirmed");

  assert.deepEqual(trace.sort(), ["ack-after-commit", "wake-after-commit"]);
  assert.equal(journal.get(MESSAGE_ID)?.wakeAttemptCount, 1);
  controller.abort();
  await running;
});

test("rejects unknown or content fields without storing any part of the poll", async (t) => {
  const journal = temporaryJournal(t);
  const leakedContent = "private task body";
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname !== "/api/poll_messages") return pendingResponse(init.signal);
    return new Response(
      JSON.stringify({
        messages: [{ id: MESSAGE_ID }, { id: "message-2", content: leakedContent }],
      }),
    );
  };
  const relay = new NotificationRelay(relayOptions(journal, request));

  await assert.rejects(relay.run(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof NotificationRelayError);
    assert.equal(error.code, "invalid_notification_response");
    assert.equal(error.message.includes(leakedContent), false);
    assert.equal(error.message.includes(CENTRAL_URL), false);
    assert.equal(error.message.includes(CENTRAL_TOKEN), false);
    return true;
  });
  assert.equal(journal.get(MESSAGE_ID), undefined);
  assert.equal(journal.get("message-2"), undefined);
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
        if (polls === 1) return new Response(JSON.stringify({ messages: [{ id: MESSAGE_ID }] }));
        return pendingResponse(init.signal);
      }
      if (url.pathname === "/api/ack_notification") return new Response(null, { status: 204 });
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

test("redrives an accepted wake until confirmed content acknowledgement", async (t) => {
  const journal = temporaryJournal(t);
  let polls = 0;
  let wakes = 0;
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") {
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ messages: [{ id: MESSAGE_ID }] }));
      return pendingResponse(init.signal);
    }
    if (url.pathname === "/api/ack_notification") return new Response(null, { status: 204 });
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

test("recovers a wake that was in flight when the prior process stopped", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-notification-restart-test-"));
  const path = join(directory, "notifications.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let journal = new NotificationJournal(path);
  journal.ingest([MESSAGE_ID], Date.now());
  journal.claimDueWake(Date.now());
  journal.close();

  journal = new NotificationJournal(path);
  t.after(() => journal.close());
  let wakes = 0;
  const request: NotificationFetch = async (url, init) => {
    if (url.pathname === "/api/poll_messages") return pendingResponse(init.signal);
    if (url.pathname === "/api/ack_notification") return new Response(null, { status: 204 });
    wakes += 1;
    return new Response(null, { status: 202 });
  };
  const relay = new NotificationRelay({
    ...relayOptions(journal, request),
    now: Date.now,
    retryBaseMs: 4,
    retryCapMs: 4,
    idleIntervalMs: 1,
  });
  const running = relay.run(new AbortController().signal);

  await waitFor(() => wakes === 1);
  assert.equal(journal.get(MESSAGE_ID)?.wakeAttemptCount, 2);
  assert.equal(journal.get(MESSAGE_ID)?.wakeMayHaveReachedWebhook, true);
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
