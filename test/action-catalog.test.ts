import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionCatalog } from "../src/action-catalog.js";

const types = [
  {
    id: "calendar-permission",
    name: "read_calendar_permission",
    description: "Read calendar access",
    input_schema: {
      type: "object",
      properties: { calendar_id: { type: "string" } },
      required: ["calendar_id"],
    },
  },
  {
    id: "calendar-event",
    name: "read_calendar_event_by_title",
    description: "Read calendar event",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
];

test("selects the exact catalog action and checks its payload before requesting permission", async () => {
  const catalog = new ActionCatalog({ listActionTypes: async () => types });
  assert.equal(
    (await catalog.require("read_calendar_event_by_title", { title: "a" })).id,
    "calendar-event",
  );
  await assert.rejects(catalog.require("read_calendar_permission", { title: "a" }), {
    code: "invalid_action_payload",
  });
  await assert.rejects(catalog.require("read_calendar", {}), { code: "action_type_unknown" });
  await assert.rejects(catalog.require("read_calendar_event_by_title", { title: 3 }), {
    code: "invalid_action_payload",
  });
});

test("catalog validation preserves server default and unsupported dialect semantics", async () => {
  const action = types[0];
  assert.ok(action);
  const catalog = new ActionCatalog({
    listActionTypes: async () => [
      {
        ...action,
        input_schema: {
          type: "object",
          properties: { calendar_id: { type: "string", default: "primary" } },
          required: ["calendar_id"],
        },
      },
    ],
  });
  await assert.rejects(catalog.require("read_calendar_permission", {}), {
    code: "invalid_action_payload",
  });
  const unsupported = new ActionCatalog({
    listActionTypes: async () => [
      {
        ...action,
        input_schema: { $schema: "https://example.test/unknown-schema", type: "object" },
      },
    ],
  });
  await assert.rejects(unsupported.require("read_calendar_permission", {}), {
    code: "action_schema_unsupported",
  });
});

test("validates nested references and conditional schemas without changing the payload", async () => {
  const action = types[1];
  assert.ok(action);
  const input_schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { title: { type: "string", minLength: 2 } },
    properties: {
      title: { $ref: "#/$defs/title" },
      exact: { type: "boolean" },
      date: { type: "string", format: "date-time" },
    },
    if: { properties: { exact: { const: true } }, required: ["exact"] },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema uses the then keyword.
    then: { required: ["title"] },
  };
  const catalog = new ActionCatalog({ listActionTypes: async () => [{ ...action, input_schema }] });
  const payload = { exact: true, title: "valid", date: "not checked by central" };
  await catalog.require(action.name, payload);
  assert.deepEqual(payload, { exact: true, title: "valid", date: "not checked by central" });
  await assert.rejects(catalog.require(action.name, { exact: true }), {
    code: "invalid_action_payload",
  });
  await assert.rejects(catalog.require(action.name, { title: "a" }), {
    code: "invalid_action_payload",
  });
  await assert.rejects(catalog.require(action.name, { exact: "true" }), {
    code: "invalid_action_payload",
  });
});

test("a property named format and enum objects retain their meaning", async () => {
  const action = types[1];
  assert.ok(action);
  const catalog = new ActionCatalog({
    listActionTypes: async () => [
      {
        ...action,
        input_schema: {
          type: "object",
          properties: { format: { const: "keep" }, value: { enum: [{ format: "keep" }] } },
          required: ["format", "value"],
        },
      },
    ],
  });
  await catalog.require(action.name, { format: "keep", value: { format: "keep" } });
  await assert.rejects(
    catalog.require(action.name, { format: "wrong", value: { format: "keep" } }),
    { code: "invalid_action_payload" },
  );
});

test("catalog changes sharing a schema ID are revalidated instead of using a stale validator", async () => {
  const action = types[1];
  assert.ok(action);
  let title = "first";
  const catalog = new ActionCatalog({
    listActionTypes: async () => [
      {
        ...action,
        input_schema: {
          $id: "https://example.test/action",
          type: "object",
          properties: { title: { const: title } },
        },
      },
    ],
  });
  await catalog.require(action.name, { title: "first" });
  title = "second";
  await assert.rejects(catalog.require(action.name, { title: "first" }), {
    code: "invalid_action_payload",
  });
});

test("expensive catalog validation is bounded without blocking the gateway event loop", async () => {
  const action = types[1];
  assert.ok(action);
  const catalog = new ActionCatalog({
    listActionTypes: async () => [
      {
        ...action,
        input_schema: {
          type: "object",
          properties: { title: { type: "string", pattern: "^(a+)+$" } },
        },
      },
    ],
  });
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try {
    await assert.rejects(catalog.require(action.name, { title: `${"a".repeat(100)}!` }), {
      code: "action_schema_unsupported",
    });
    assert.ok(ticks > 1);
  } finally {
    clearInterval(heartbeat);
  }
});
