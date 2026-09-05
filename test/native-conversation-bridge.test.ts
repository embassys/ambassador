import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  conversationUpdateText,
  NativeConversationBridge,
  NativeRouteStore,
} from "../src/native-conversation-bridge.js";

test("direct conversation presentation includes result values without internal workflow metadata", () => {
  const text = conversationUpdateText({
    request_id: randomUUID(),
    status: "completed",
    events: [
      {
        type: "action_result",
        data: {
          action_type: "get_phone_number",
          status: "success",
          result: { phone_number: "+447700900123" },
        },
      },
    ],
  });
  assert.match(text, /Phone number: \+447700900123/);
  assert.doesNotMatch(text, /request_id|acknowledge|action_result/);
});

test("native delivery uses captured conversation context, persists receipt and never submits an action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-"));
  const store = new NativeRouteStore(join(root, "routes.sqlite"));
  const requestId = randomUUID();
  const cursor = randomUUID();
  const calls: Record<string, unknown>[] = [];
  const delivered: string[] = [];
  const bridge = new NativeConversationBridge({
    store,
    callBox: async (input) => {
      calls.push(input);
      return input.type === "acknowledge"
        ? { status: "acknowledged" }
        : {
            request_id: requestId,
            status: "completed",
            cursor,
            events: [
              {
                cursor,
                type: "action_result",
                data: { result: { phone_number: "synthetic-number" } },
              },
            ],
          };
    },
    deliver: async (conversation, message) => {
      assert.equal(conversation, "trusted-session");
      delivered.push(message);
      return "displayed";
    },
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  bridge.bind(requestId.toUpperCase(), "trusted-session");
  bridge.bind(requestId, "trusted-session");
  assert.throws(() => bridge.bind(requestId, "another-session"));
  await bridge.observe(requestId.toUpperCase());
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /synthetic-number/u);
  assert.deepEqual(
    calls.map((call) => call.type),
    ["check", "acknowledge"],
  );
  assert.equal(store.get(requestId)?.status, "completed");
  await bridge.observe(requestId);
  assert.equal(delivered.length, 1);
});

test("an ambiguous native injection is never replayed and does not acknowledge the result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "routes.sqlite");
  let store = new NativeRouteStore(path);
  const requestId = randomUUID();
  let delivered = 0;
  let receipts = 0;
  const options = {
    get store() {
      return store;
    },
    callBox: async (input: Record<string, unknown>) => {
      if (input.type === "acknowledge") receipts++;
      return {
        request_id: input.request_id,
        status: "completed",
        cursor: randomUUID(),
        events: [{ type: "action_result" }],
      };
    },
    deliver: async () => {
      delivered++;
      throw new Error("response lost after injection");
    },
  };
  let bridge = new NativeConversationBridge(options);
  bridge.bind(requestId, "original");
  await bridge.observe(requestId);
  await bridge.close();
  store.close();
  store = new NativeRouteStore(path);
  bridge = new NativeConversationBridge(options);
  await bridge.resume();
  assert.equal(store.get(requestId)?.status, "uncertain");
  assert.equal(delivered, 1);
  assert.equal(receipts, 0);
  await bridge.close();
  store.close();
});

test("queued native injection retains the inbox result and unavailable conversations cannot redirect it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-"));
  const store = new NativeRouteStore(join(root, "routes.sqlite"));
  let calls = 0;
  const bridge = new NativeConversationBridge({
    store,
    callBox: async (input) => {
      calls++;
      return {
        request_id: input.request_id,
        status: "completed",
        cursor: randomUUID(),
        events: [{ type: "action_result" }],
      };
    },
    deliver: async (conversation) => (conversation === "queued" ? "accepted" : "unavailable"),
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const queued = randomUUID();
  const missing = randomUUID();
  bridge.bind(queued, "queued");
  bridge.bind(missing, "missing");
  await bridge.observe(queued);
  await bridge.observe(missing);
  assert.equal(store.get(queued)?.status, "accepted");
  assert.equal(store.get(missing)?.status, "unavailable");
  assert.equal(calls, 2);
});

test("a queued progress notification keeps observing until the final result, which remains unread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-progress-"));
  const store = new NativeRouteStore(join(root, "routes.sqlite"));
  const id = randomUUID();
  let checks = 0;
  let receipts = 0;
  let notifications = 0;
  const bridge = new NativeConversationBridge({
    store,
    callBox: async (input) => {
      if (input.type === "acknowledge") {
        receipts++;
        return { status: "acknowledged" };
      }
      checks++;
      return {
        request_id: id,
        status: checks === 1 ? "pending" : "completed",
        cursor: randomUUID(),
        events: [{ type: checks === 1 ? "permission_status" : "action_result" }],
      };
    },
    deliver: async () => {
      notifications++;
      return "accepted";
    },
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  bridge.bind(id, "original");
  await bridge.observe(id);
  assert.equal(notifications, 2);
  assert.equal(receipts, 1);
  assert.equal(store.get(id)?.status, "accepted");
});

test("an expired central credential pauses native observation without a hot retry loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-expiry-"));
  const store = new NativeRouteStore(join(root, "routes.sqlite"));
  const id = randomUUID();
  let checks = 0;
  const bridge = new NativeConversationBridge({
    store,
    callBox: async () => {
      checks++;
      return { request_id: id, status: "pending", reason: "credential_expired", events: [] };
    },
    deliver: async () => {
      throw new Error("No delivery expected");
    },
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  bridge.bind(id, "original");
  await bridge.observe(id);
  assert.equal(checks, 1);
});

test("native return yields to an active foreground turn and rereads its receipt before injection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-foreground-"));
  const store = new NativeRouteStore(join(root, "routes.sqlite"));
  const id = randomUUID();
  let checks = 0;
  let idleChecks = 0;
  let delivered = 0;
  const bridge = new NativeConversationBridge({
    store,
    async isConversationIdle(conversation) {
      assert.equal(conversation, "original");
      // A user starts a turn while the native observer waits for the result.
      // The foreground consumes and acknowledges it before ending that turn.
      return ++idleChecks !== 2;
    },
    async callBox(input) {
      assert.equal(input.type, "check");
      return {
        request_id: id,
        status: "completed",
        cursor: randomUUID(),
        events: ++checks === 1 ? [{ type: "action_result" }] : [],
      };
    },
    async deliver() {
      delivered++;
      return "accepted";
    },
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  bridge.bind(id, "original");
  await bridge.observe(id);
  assert.equal(checks, 2);
  assert.equal(delivered, 0);
  assert.equal(store.get(id)?.status, "completed");
});

test("shutdown during an active conversation preserves the route for a later idle delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-busy-restart-"));
  const path = join(root, "routes.sqlite");
  let store = new NativeRouteStore(path);
  const id = randomUUID();
  let busy = true;
  let checked!: () => void;
  const activityChecked = new Promise<void>((resolve) => {
    checked = resolve;
  });
  let calls = 0;
  let delivered = 0;
  const options = {
    get store() {
      return store;
    },
    async isConversationIdle() {
      checked();
      return !busy;
    },
    async callBox(input: Record<string, unknown>) {
      assert.equal(input.type, "check");
      calls++;
      return {
        request_id: id,
        status: "completed",
        cursor: randomUUID(),
        events: [{ type: "action_result" }],
      };
    },
    async deliver() {
      delivered++;
      return "accepted" as const;
    },
  };
  let bridge = new NativeConversationBridge(options);
  t.after(async () => {
    await bridge.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  bridge.bind(id, "original");
  const waiting = bridge.observe(id);
  await activityChecked;
  await bridge.close();
  await waiting;
  assert.equal(calls, 0);
  assert.equal(store.get(id)?.status, "waiting");
  store.close();
  store = new NativeRouteStore(path);
  busy = false;
  bridge = new NativeConversationBridge(options);
  await bridge.resume();
  assert.equal(calls, 1);
  assert.equal(delivered, 1);
  assert.equal(store.get(id)?.status, "accepted");
});
