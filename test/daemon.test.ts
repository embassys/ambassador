import assert from "node:assert/strict";
import { test } from "node:test";
import { ControllerRequestError } from "../src/controller.js";
import { type DaemonEvent, runDaemon } from "../src/daemon.js";

test("recovers in-flight work before running relay iterations serially", async () => {
  const trace: string[] = [];
  const controller = new AbortController();
  let active = 0;
  let iterations = 0;

  await runDaemon(
    {
      journal: {
        recoverInFlight(nowMs) {
          trace.push(`recover:${nowMs}`);
          return 1;
        },
      },
      relay: {
        async runOnce() {
          active += 1;
          assert.equal(active, 1);
          iterations += 1;
          trace.push(`run:${iterations}`);
          active -= 1;
          if (iterations === 2) controller.abort();
        },
      },
      now: () => 1234,
    },
    controller.signal,
  );

  assert.deepEqual(trace, ["recover:1234", "run:1", "run:2"]);
});

test("reports a safe event and delays after an iteration failure", async () => {
  const controller = new AbortController();
  const events: DaemonEvent[] = [];
  const delays: number[] = [];
  let attempts = 0;

  await runDaemon(
    {
      journal: { recoverInFlight: () => 0 },
      relay: {
        async runOnce() {
          attempts += 1;
          if (attempts === 1) throw new Error("remote body must not be logged");
          controller.abort();
        },
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onEvent: (event) => events.push(event),
    },
    controller.signal,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(events, [{ code: "relay_iteration_failed" }]);
  assert.equal(JSON.stringify(events).includes("remote body"), false);
});

test("does no work when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await runDaemon(
    {
      journal: { recoverInFlight: () => ++calls },
      relay: { runOnce: async () => void ++calls },
    },
    controller.signal,
  );

  assert.equal(calls, 0);
});

test("yields after a successful iteration so a full retry queue cannot spin", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let iterations = 0;

  await runDaemon(
    {
      journal: { recoverInFlight: () => 0 },
      relay: {
        async runOnce() {
          iterations += 1;
          if (iterations === 1_000) controller.abort();
        },
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        controller.abort();
      },
    },
    controller.signal,
  );

  assert.equal(iterations, 1);
  assert.deepEqual(delays, [100]);
});

test("honors controller retry delays and stops on permanent controller failures", async () => {
  const retryController = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  await runDaemon(
    {
      journal: { recoverInFlight: () => 0 },
      relay: {
        async runOnce() {
          attempts += 1;
          if (attempts === 1) {
            throw new ControllerRequestError("rate_limited", true, 5_000);
          }
          retryController.abort();
        },
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
    retryController.signal,
  );
  assert.deepEqual(delays, [5_000]);

  await assert.rejects(
    runDaemon(
      {
        journal: { recoverInFlight: () => 0 },
        relay: {
          async runOnce() {
            throw new ControllerRequestError("authentication_failed", false);
          },
        },
      },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof ControllerRequestError && error.code === "authentication_failed",
  );
});
