import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { type OpenClawBridgeState, registerOpenClawBridge } from "../src/openclaw-native-bridge.js";

test("tool activation reuses the bridge started by a separate gateway registration", async () => {
  type Api = Parameters<typeof registerOpenClawBridge>[0];
  const state: OpenClawBridgeState = {};
  let service: Parameters<Api["registerService"]>[0] | undefined;
  let hook: Parameters<Api["on"]>[1] | undefined;
  let starts = 0;
  let bound = 0;
  const create = async () => {
    starts++;
    return {
      bind() {
        bound++;
      },
      async observe() {},
      async resume() {},
      async close() {},
    };
  };
  registerOpenClawBridge(
    {
      on() {},
      registerService(value) {
        service = value;
      },
      logger: { warn() {} },
    },
    create,
    state,
  );
  assert.ok(service);
  await service.start({ stateDir: "/tmp/provider-owned-state" });
  registerOpenClawBridge(
    {
      on(name, value) {
        if (name === "after_tool_call") hook = value;
      },
      registerService() {},
      logger: { warn() {} },
    },
    create,
    state,
  );
  assert.ok(hook);
  await hook(
    {
      toolName: "mcp__ambassador__message_box",
      params: { type: "request_action", request_id: randomUUID() },
    },
    { sessionKey: "trusted" },
  );
  assert.equal(starts, 1);
  assert.equal(bound, 1);
  await service.stop();
});

test("the packaged native bridge requests gateway startup activation", async () => {
  const manifest = JSON.parse(await readFile("extensions/openclaw/openclaw.plugin.json", "utf8"));
  assert.equal(manifest.activation?.onStartup, true);
});

test("OpenClaw retries bridge startup on a later request when Ambassador was offline", async () => {
  type Api = Parameters<typeof registerOpenClawBridge>[0];
  const hooks = new Map<string, Parameters<Api["on"]>[1]>();
  let service: Parameters<Api["registerService"]>[0] | undefined;
  let attempts = 0;
  let bound = 0;
  let closed = 0;
  registerOpenClawBridge(
    {
      on: (name, callback) => {
        hooks.set(name, callback);
      },
      registerService: (value) => {
        service = value;
      },
      logger: { warn() {} },
    },
    async () => {
      if (++attempts === 1) throw new Error("Ambassador is offline");
      return {
        bind() {
          bound++;
        },
        async observe() {},
        async resume() {},
        async close() {
          closed++;
        },
      };
    },
  );
  assert.ok(service);
  await service.start({ stateDir: "/tmp/provider-owned-state" });
  const event = {
    toolName: "ambassador.message_box",
    params: { type: "request_action", request_id: randomUUID() },
  };
  await hooks.get("after_tool_call")?.(event, { sessionKey: "trusted" });
  assert.equal(attempts, 2);
  assert.equal(bound, 1);
  await service.stop();
  await hooks.get("after_tool_call")?.(event, { sessionKey: "trusted" });
  assert.equal(attempts, 2);
  assert.equal(closed, 1);
});

test("OpenClaw hooks bind the provider session and preserve the foreground wait", async () => {
  type Api = Parameters<typeof registerOpenClawBridge>[0];
  const hooks = new Map<string, Parameters<Api["on"]>[1]>();
  let service: Parameters<Api["registerService"]>[0] | undefined;
  const bindings: unknown[] = [];
  const observed: unknown[] = [];
  registerOpenClawBridge(
    {
      on: (name, callback) => {
        hooks.set(name, callback);
      },
      registerService: (value) => {
        service = value;
      },
      logger: { warn() {} },
    },
    async () => ({
      bind: (...args: unknown[]) => {
        bindings.push(args);
      },
      observe: async (id: unknown) => {
        observed.push(id);
      },
      resume: async () => {},
      close: async () => {},
    }),
  );
  assert.ok(service);
  await service.start({ stateDir: "/tmp/provider-owned-state" });
  const input = {
    type: "request_action",
    request_id: randomUUID(),
    target_email: "peer@example.test",
    origin: "untrusted-target",
  };
  const before = hooks.get("before_tool_call");
  assert.ok(before);
  assert.equal(
    await before({ toolName: "other__message_box", params: input }, { sessionKey: "trusted" }),
    undefined,
  );
  assert.equal(await before({ toolName: "ambassador__message_box", params: input }, {}), undefined);
  assert.equal(
    await before({ toolName: "ambassador__message_box", params: input }, { sessionKey: "trusted" }),
    undefined,
  );
  assert.deepEqual(bindings, [[input.request_id, "trusted"]]);
  await hooks.get("after_tool_call")?.(
    { toolName: "ambassador__message_box", params: input },
    { sessionKey: "trusted" },
  );
  assert.deepEqual(observed, [input.request_id]);
  const native = { ...input, request_id: randomUUID(), wait_seconds: 600 };
  assert.equal(
    await before(
      { toolName: "mcp__ambassador__message_box", params: native },
      { sessionKey: "native" },
    ),
    undefined,
  );
  assert.equal(native.wait_seconds, 600);
  assert.deepEqual(bindings.at(-1), [native.request_id, "native"]);
  await hooks.get("after_tool_call")?.(
    { toolName: "mcp__ambassador__message_box", params: native },
    { sessionKey: "native" },
  );
  assert.deepEqual(observed, [input.request_id, native.request_id]);
  // Native Codex completion telemetry may be the first hook for an MCP call.
  const telemetry = { ...native, request_id: randomUUID() };
  await hooks.get("after_tool_call")?.(
    { toolName: "ambassador.message_box", params: telemetry },
    { sessionKey: "native-telemetry" },
  );
  assert.deepEqual(bindings.at(-1), [telemetry.request_id, "native-telemetry"]);
  assert.equal(observed.at(-1), telemetry.request_id);
  assert.equal(
    await before(
      { toolName: "ambassador.message_box", params: telemetry },
      { sessionKey: "native-telemetry" },
    ),
    undefined,
  );
  assert.equal(telemetry.wait_seconds, 600);
  await service.stop();
});
