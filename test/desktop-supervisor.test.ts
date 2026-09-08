import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DesktopCommand, GatewaySnapshot } from "../src/desktop/protocol.js";
import { SupervisedGateway } from "../src/desktop/supervisor.js";

test("an authenticated handoff clears restart intent before the old worker exits", async () => {
  const id = randomUUID();
  let changed = () => {};
  let alive = true;
  let state: GatewaySnapshot = { id, state: "running" };
  let handedOff = 0;
  let restarts = 0;
  const supervisor = new SupervisedGateway({
    id,
    onHandoff: () => {
      handedOff++;
    },
    create: (notify) => {
      changed = notify;
      return {
        available: () => alive,
        snapshot: () => state,
        request: async () => state,
        close: async () => {
          alive = false;
        },
      };
    },
    schedule: () => {
      restarts++;
      return () => {};
    },
  });
  await supervisor.request({ type: "start", instanceId: id });
  state = { id, state: "stopping", stopReason: "handoff" };
  changed();
  state = { id, state: "stopped", stopReason: "handoff" };
  changed();
  alive = false;
  changed();
  assert.equal(handedOff, 1);
  assert.equal(restarts, 0);
  await supervisor.close();
});

test("worker recovery is bounded and never replays a mutation", async () => {
  const id = randomUUID();
  const created: Fake[] = [];
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  class Fake {
    alive = true;
    commands: DesktopCommand[] = [];
    state: GatewaySnapshot = { id, state: "stopped" };
    constructor(readonly changed: () => void) {}
    available() {
      return this.alive;
    }
    snapshot() {
      return this.state;
    }
    async request(command: DesktopCommand) {
      this.commands.push(command);
      this.state = { id, state: "running" };
      this.changed();
      return this.state;
    }
    async close() {
      this.alive = false;
    }
    crash() {
      this.alive = false;
      this.state = { id, state: "error" };
      this.changed();
    }
  }
  const supervisor = new SupervisedGateway({
    id,
    create: (changed) => {
      const client = new Fake(changed);
      created.push(client);
      return client;
    },
    schedule: (callback, delay) => {
      const item = { callback, delay, cancelled: false };
      timers.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  });
  await supervisor.request({ type: "start", instanceId: id });
  await supervisor.request({
    type: "clean",
    instanceId: id,
    confirmation: "clear-local-instance",
    previewId: randomUUID(),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    created.at(-1)?.crash();
    const timer = timers.at(-1);
    assert.ok(timer);
    timer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      created.at(-1)?.commands.map((command) => command.type),
      ["start"],
    );
  }
  created.at(-1)?.crash();
  assert.equal(timers.length, 3);
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [2000, 8000, 30000],
  );
  assert.match(supervisor.snapshot().error ?? "", /three/u);
  await supervisor.close();
});

test("intentional shutdown cancels a pending restart", async () => {
  const id = randomUUID();
  let alive = true;
  let changed: () => void = () => undefined;
  let scheduled: (() => void) | undefined;
  let creations = 0;
  const supervisor = new SupervisedGateway({
    id,
    create: (notify) => {
      creations++;
      changed = notify;
      return {
        available: () => alive,
        snapshot: () => ({ id, state: alive ? "running" : "error" }),
        request: async () => ({}),
        close: async () => {
          alive = false;
        },
      };
    },
    schedule: (callback) => {
      scheduled = callback;
      return () => undefined;
    },
  });
  await supervisor.request({ type: "start", instanceId: id });
  alive = false;
  changed();
  await supervisor.close();
  scheduled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(creations, 1);
  await assert.rejects(supervisor.request({ type: "start", instanceId: id }));
});

test("failed starts and stopped reads release workers while preserving the visible error", async () => {
  const id = randomUUID();
  let closed = 0;
  let mode: "error" | "stopped" = "error";
  const supervisor = new SupervisedGateway({
    id,
    create: () => ({
      available: () => true,
      snapshot: () => ({
        id,
        state: mode,
        ...(mode === "error" ? { error: "Port is occupied" } : {}),
      }),
      request: async () => ({}),
      close: async () => {
        closed++;
      },
    }),
  });
  await supervisor.request({ type: "start", instanceId: id });
  assert.equal(closed, 1);
  assert.match(supervisor.snapshot().error ?? "", /occupied/u);
  mode = "stopped";
  await supervisor.request({ type: "logs", instanceId: id });
  assert.equal(closed, 2);
  assert.match(supervisor.snapshot().error ?? "", /occupied/u);
  await supervisor.close();
});

test("a read during Clean review preserves its worker and exclusive custody", async () => {
  const id = randomUUID();
  const previewId = randomUUID();
  let closed = 0;
  const supervisor = new SupervisedGateway({
    id,
    create: () => ({
      available: () => true,
      snapshot: () => ({ id, state: "stopped" }),
      request: async () => ({ previewId }),
      close: async () => {
        closed++;
      },
    }),
  });
  await supervisor.request({ type: "clean_preview", instanceId: id });
  await supervisor.request({ type: "logs", instanceId: id });
  assert.equal(closed, 0);
  await supervisor.request({ type: "clean_cancel", instanceId: id, previewId });
  assert.equal(closed, 1);
  await supervisor.close();
});

test("a failed stopped read releases the worker without hiding the failure", async () => {
  const id = randomUUID();
  let closed = false;
  const supervisor = new SupervisedGateway({
    id,
    create: () => ({
      available: () => true,
      snapshot: () => ({ id, state: "stopped" }),
      request: async () => {
        throw new Error("Cannot review saved work");
      },
      close: async () => {
        closed = true;
      },
    }),
  });
  await assert.rejects(
    supervisor.request({ type: "clean_preview", instanceId: id }),
    /Cannot review/,
  );
  assert.equal(closed, true);
  await supervisor.close();
});
