import assert from "node:assert/strict";
import { test } from "node:test";
import { NativePushRegistration } from "../src/desktop/native-push.js";

test("native push checks server support before asking the OS and never accepts a renderer token", async () => {
  let available = false;
  let registrations = 0;
  let sent = 0;
  const push = new NativePushRegistration({
    platform: "darwin",
    status: async () => ({ available, registered: false, reason: "Server not configured" }),
    osToken: async () => {
      registrations++;
      return "a".repeat(64);
    },
    register: async (token) => {
      assert.equal(token, "a".repeat(64));
      sent++;
    },
    unregister: async () => {},
  });
  await push.configure("context", true);
  assert.equal(registrations, 0);
  available = true;
  await push.configure("context", true, true);
  assert.equal(push.snapshot().state, "registered");
  await push.configure("context", true);
  assert.equal(registrations, 1);
  assert.equal(sent, 1);
});
test("disabling notifications during OS registration prevents an obsolete token from being sent", async () => {
  let finish!: (token: string) => void;
  let sent = 0;
  const push = new NativePushRegistration({
    platform: "darwin",
    status: async () => ({ available: true, registered: false }),
    osToken: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    register: async () => {
      sent++;
    },
    unregister: async () => {},
  });
  const pending = push.configure("a", true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await push.configure("a", false);
  finish("a".repeat(64));
  await pending;
  assert.equal(sent, 0);
  assert.equal(push.snapshot().state, "disabled");
});
