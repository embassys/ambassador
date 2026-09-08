import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopQuitLifecycle } from "../src/desktop/quit-lifecycle.js";

test("an idle native quit finishes on a later event-loop turn, outside native event dispatch", async () => {
  let inNativeEvent = true;
  let quits = 0;
  const lifecycle = new DesktopQuitLifecycle({
    stop: async () => {},
    quit: () => {
      assert.equal(inNativeEvent, false);
      quits++;
    },
    failed: () => assert.fail("shutdown must succeed"),
  });
  assert.equal(lifecycle.request(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(quits, 0);
  inNativeEvent = false;
  await lifecycle.completion;
  assert.equal(quits, 1);
  assert.equal(lifecycle.request(), false);
});

test("repeated native Quit cannot bypass outstanding server cleanup", async () => {
  let finish!: () => void;
  let stops = 0;
  let quits = 0;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const lifecycle = new DesktopQuitLifecycle({
    stop: async () => {
      stops++;
      await stopped;
    },
    quit: () => {
      quits++;
    },
    failed: () => assert.fail("shutdown must succeed"),
  });
  assert.equal(lifecycle.request(), true);
  assert.equal(lifecycle.request(), true);
  assert.equal(lifecycle.stopping, true);
  assert.equal(stops, 1);
  assert.equal(quits, 0);
  finish();
  await lifecycle.completion;
  assert.equal(quits, 1);
});

test("failed cleanup reopens controls and permits a deliberate retry", async () => {
  let failures = 0;
  let quits = 0;
  const lifecycle = new DesktopQuitLifecycle({
    stop: async () => {
      if (failures === 0) throw new Error("still stopping");
    },
    quit: () => {
      quits++;
    },
    failed: () => {
      failures++;
    },
  });
  assert.equal(lifecycle.request(), true);
  await lifecycle.completion;
  assert.equal(lifecycle.stopping, false);
  assert.equal(failures, 1);
  assert.equal(quits, 0);
  assert.equal(lifecycle.request(), true);
  await lifecycle.completion;
  assert.equal(quits, 1);
});
