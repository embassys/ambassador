import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import type { CentralMessage } from "../src/central-rest.js";
import { NotificationJournal } from "../src/notification-journal.js";
import {
  type DeliveryTarget,
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "../src/notification-relay.js";

const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  action_type_id: "get_email",
  payload: { reason: "private message body" },
  created_at: "2026-08-27T12:00:00Z",
};

function journal(t: TestContext): { journal: NotificationJournal; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "ambassador-relay-"));
  const path = join(directory, "notifications.sqlite3");
  const value = new NotificationJournal(path);
  t.after(() => {
    value.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { journal: value, path };
}

function pending(signal: AbortSignal): Promise<readonly CentralMessage[]> {
  return new Promise((_, reject) => {
    const cancelled = () => reject(new Error("cancelled"));
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("delivers the complete message, records custody, then acknowledges", async (t) => {
  const item = journal(t);
  const events: string[] = [];
  let polls = 0;
  const target: DeliveryTarget = {
    async deliver(message) {
      events.push(`deliver:${message.payload.reason as string}`);
      assert.equal(item.journal.get("message-1")?.deliveryState, "delivering");
      return { status: "accepted" };
    },
    async close() {},
  };
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: target,
    receiveMessages: async (signal) => (++polls === 1 ? [MESSAGE, MESSAGE] : pending(signal)),
    captureMessage: async (message) => {
      events.push(`capture:${message.id}`);
      assert.equal(item.journal.get("message-1")?.deliveryState, "pending");
    },
    acknowledgeMessage: async (id) => {
      events.push(`ack:${id}`);
      assert.equal(item.journal.get(id)?.deliveryState, "acknowledging");
    },
    retryDelayMs: 1,
  });
  const controller = new AbortController();
  const running = relay.run(controller.signal);
  await waitFor(() => events.length === 3);
  assert.deepEqual(events, ["capture:message-1", "deliver:private message body", "ack:message-1"]);
  assert.equal(item.journal.count(), 0);
  assert.equal(readFileSync(item.path).includes(Buffer.from("private message body")), false);
  controller.abort();
  await running;
});

test("stops before delivery or acknowledgement when durable capture fails", async (t) => {
  const item = journal(t);
  let delivered = 0;
  let acknowledged = 0;
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: {
      async deliver() {
        delivered += 1;
        return { status: "completed" };
      },
      async close() {},
    },
    receiveMessages: async () => [MESSAGE],
    captureMessage: async () => {
      throw new Error("capture failed");
    },
    acknowledgeMessage: async () => {
      acknowledged += 1;
    },
    retryDelayMs: 1,
  });

  await assert.rejects(relay.run(new AbortController().signal), NotificationRelayError);
  assert.equal(delivered, 0);
  assert.equal(acknowledged, 0);
});

test("delivers ID-less messages once without acknowledgement", async (t) => {
  const item = journal(t);
  const { id: _id, ...message } = MESSAGE;
  let delivered = 0;
  let acknowledgements = 0;
  let polls = 0;
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: {
      async deliver() {
        delivered += 1;
        return { status: "completed" };
      },
      async close() {},
    },
    receiveMessages: async (signal) => (++polls === 1 ? [message, message] : pending(signal)),
    acknowledgeMessage: async () => {
      acknowledgements += 1;
    },
    retryDelayMs: 1,
  });
  const controller = new AbortController();
  const running = relay.run(controller.signal);
  await waitFor(() => delivered === 2);
  assert.equal(acknowledgements, 0);
  assert.equal(item.journal.count(), 0);
  controller.abort();
  await running;
});

test("does not redeliver completed custody while recovering a safe acknowledgement", async (t) => {
  const item = journal(t);
  item.journal.ingest(["message-1"]);
  item.journal.beginDelivery("message-1");
  item.journal.recordDelivered("message-1", "completed");
  let delivered = 0;
  let acknowledged = 0;
  const controller = new AbortController();
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: {
      async deliver() {
        delivered += 1;
        return { status: "completed" };
      },
      async close() {},
    },
    receiveMessages: pending,
    acknowledgeMessage: async () => {
      acknowledged += 1;
    },
    retryDelayMs: 1,
  });
  const running = relay.run(controller.signal);
  await waitFor(() => acknowledged === 1);
  assert.equal(delivered, 0);
  assert.equal(item.journal.count(), 0);
  controller.abort();
  await running;
});

test("discards consumed pre-delivery IDs after restart and shuts down target", async (t) => {
  const item = journal(t);
  item.journal.ingest(["consumed-before-crash"]);
  let closed = 0;
  const controller = new AbortController();
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: {
      async deliver() {
        return { status: "accepted" };
      },
      async close() {
        closed += 1;
      },
    },
    receiveMessages: pending,
    acknowledgeMessage: async () => undefined,
    retryDelayMs: 1,
  });
  const running = relay.run(controller.signal);
  await waitFor(() => item.journal.count() === 0);
  controller.abort();
  await running;
  assert.equal(closed, 1);
});

test("explicit shutdown aborts the receive and closes the target once", async (t) => {
  const item = journal(t);
  let closed = 0;
  const relay = new NotificationRelay({
    journal: item.journal,
    deliveryTarget: {
      async deliver() {
        return { status: "accepted" };
      },
      async close() {
        closed += 1;
      },
    },
    receiveMessages: pending,
    acknowledgeMessage: async () => undefined,
    retryDelayMs: 1,
  });
  relay.run(new AbortController().signal);
  await relay.shutdown();
  assert.equal(closed, 1);
});

test("retries receive failures but fails closed on an oversized batch", async (t) => {
  const first = journal(t);
  let attempts = 0;
  const controller = new AbortController();
  const target: DeliveryTarget = {
    async deliver() {
      return { status: "accepted" };
    },
    async close() {},
  };
  const relay = new NotificationRelay({
    journal: first.journal,
    deliveryTarget: target,
    receiveMessages: async (signal) => {
      attempts += 1;
      if (attempts === 1) throw new RetryableNotificationReceiveError(1);
      return pending(signal);
    },
    acknowledgeMessage: async () => undefined,
    retryDelayMs: 1,
  });
  const running = relay.run(controller.signal);
  await waitFor(() => attempts === 2);
  controller.abort();
  await running;

  const second = journal(t);
  const invalid = new NotificationRelay({
    journal: second.journal,
    deliveryTarget: target,
    receiveMessages: async () =>
      Array.from({ length: 257 }, (_, index) => ({ ...MESSAGE, id: `m-${index}` })),
    acknowledgeMessage: async () => undefined,
    retryDelayMs: 1,
  });
  await assert.rejects(
    invalid.run(new AbortController().signal),
    (error: unknown) =>
      error instanceof NotificationRelayError && error.code === "invalid_notification_response",
  );
});
