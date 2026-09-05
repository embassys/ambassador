import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import {
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "../src/notification-relay.js";
import { NotificationStore } from "../src/notification-store.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "peer",
  created_at: "2026-09-05T00:00:00Z",
  payload: { type: "action_call" },
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ambassador-relay-"));
  const store = new NotificationStore(
    join(root, "notifications.sqlite"),
    parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS),
  );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}
function pending(signal: AbortSignal): Promise<readonly CentralMessage[]> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve([]);
    else signal.addEventListener("abort", () => resolve([]), { once: true });
  });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition was not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("a later central reply unblocks delivery while capture and acknowledgement continue", async (t) => {
  const store = fixture(t);
  const controller = new AbortController();
  let release!: () => void;
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveryStarted = false;
  let deliveryDone = false;
  let polls = 0;
  const acknowledgements: string[] = [];
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 2,
    receiveMessages: async (signal) => {
      polls++;
      if (polls === 1) return [MESSAGE, MESSAGE];
      if (polls === 2) {
        await until(() => deliveryStarted);
        return [{ ...MESSAGE, id: "reply", payload: { type: "action_response" } }];
      }
      return pending(signal);
    },
    captureMessage: (message) => {
      if (message.id === "reply") {
        release();
        return false;
      }
      return true;
    },
    acknowledgeMessage: async (id) => {
      assert.ok(store.get(id)?.message);
      acknowledgements.push(id);
    },
    deliveryTarget: {
      async deliver(message) {
        assert.equal(message.id, MESSAGE.id);
        deliveryStarted = true;
        await answer;
        deliveryDone = true;
        return { status: "completed" };
      },
      async close() {
        release();
      },
    },
  });
  const running = relay.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  await until(() => deliveryDone && acknowledgements.length === 2);
  assert.equal(polls >= 3, true);
  assert.equal(store.get("reply")?.delivery, "skipped");
});

test("provider failure preserves uncertain work and does not stop receiving or capture", async (t) => {
  const store = fixture(t);
  const controller = new AbortController();
  let polls = 0;
  let failures = 0;
  let captures = 0;
  let deliveries = 0;
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 2,
    receiveMessages: async (signal) => {
      if (++polls === 1) return [MESSAGE];
      if (polls === 2) {
        await until(() => failures === 1);
        return [{ ...MESSAGE, id: "later" }];
      }
      return pending(signal);
    },
    captureMessage: () => {
      captures++;
      return true;
    },
    acknowledgeMessage: async () => {},
    onDeliveryError: () => {
      failures++;
    },
    deliveryTarget: {
      async deliver() {
        deliveries++;
        throw new Error("provider unavailable");
      },
      async close() {},
    },
  });
  const running = relay.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  await until(() => captures === 2);
  assert.equal(deliveries, 1);
  assert.equal(store.get("message-1")?.delivery, "uncertain");
  assert.equal(store.get("later")?.delivery, "pending");
});

test("conflicting receipt stops before any processing or acknowledgement", async (t) => {
  const store = fixture(t);
  let delivered = 0;
  let acknowledged = 0;
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 2,
    receiveMessages: async () => [MESSAGE, { ...MESSAGE, payload: { changed: true } }],
    acknowledgeMessage: async () => {
      acknowledged++;
    },
    deliveryTarget: {
      async deliver() {
        delivered++;
        return { status: "completed" };
      },
      async close() {},
    },
  });
  await assert.rejects(relay.run(new AbortController().signal), NotificationRelayError);
  assert.equal(delivered, 0);
  assert.equal(acknowledged, 0);
  assert.equal(store.next("process"), undefined);
});

test("uncertain acknowledgement reports once without stopping reception or retrying", async (t) => {
  const store = fixture(t);
  let polls = 0;
  let acknowledgements = 0;
  let errors = 0;
  const controller = new AbortController();
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 2,
    receiveMessages: async (signal) => (++polls <= 2 ? [MESSAGE] : pending(signal)),
    captureMessage: () => false,
    acknowledgeMessage: async () => {
      acknowledgements++;
      throw new Error("lost ack response");
    },
    onAcknowledgementError: () => {
      errors++;
    },
    deliveryTarget: {
      async deliver() {
        assert.fail("internal event must not be prompted");
      },
      async close() {},
    },
  });
  const running = relay.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  await until(() => errors === 1 && polls === 3);
  assert.equal(acknowledgements, 1);
  assert.equal(store.get("message-1")?.acknowledgement, "uncertain");
});

test("retries transient receives, rejects oversized batches and closes once", async (t) => {
  const store = fixture(t);
  let polls = 0;
  let closed = 0;
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 1,
    receiveMessages: async () => {
      if (++polls === 1) throw new RetryableNotificationReceiveError(1);
      return Array.from({ length: 257 }, (_, i) => ({ ...MESSAGE, id: `m-${i}` }));
    },
    acknowledgeMessage: async () => {},
    deliveryTarget: {
      async deliver() {
        assert.fail("oversized batch");
      },
      async close() {
        closed++;
      },
    },
  });
  await assert.rejects(relay.run(new AbortController().signal), NotificationRelayError);
  assert.equal(polls, 2);
  assert.equal(closed, 1);
});

test("shutdown cancels receive and workers and closes the provider once", async (t) => {
  const store = fixture(t);
  let closed = 0;
  const relay = new NotificationRelay({
    store,
    retryDelayMs: 2,
    receiveMessages: pending,
    acknowledgeMessage: async () => {},
    deliveryTarget: {
      async deliver() {
        return { status: "completed" };
      },
      async close() {
        closed++;
      },
    },
  });
  const running = relay.run(new AbortController().signal);
  assert.throws(() => relay.run(new AbortController().signal));
  await relay.shutdown();
  await running;
  assert.equal(closed, 1);
});
