import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DesktopCommand, GatewaySnapshot } from "../src/desktop/protocol.js";
import { SupervisedGateway } from "../src/desktop/supervisor.js";

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
