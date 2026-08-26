import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeUpstreamResult,
  localToolDefinition,
  McpContractError,
  parseVerificationSuccess,
  selectCentralTools,
  upstreamToolArguments,
} from "../src/mcp-contract.js";

const JWT = "central-jwt-value-not-for-local-results";

const catalog = [
  {
    name: "register_agent",
    description: "register",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, email: { type: "string" } },
      required: ["username", "email"],
      additionalProperties: false,
    },
  },
  {
    name: "poll_messages",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" }, timeout: { type: "number" } },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "health_check",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "unapproved_tool",
    inputSchema: { type: "object", properties: {} },
  },
];

test("selects only approved tools for the enrollment state", () => {
  assert.deepEqual(
    selectCentralTools(catalog, false).map((tool) => tool.name),
    ["register_agent"],
  );
  assert.deepEqual(
    selectCentralTools(catalog, true).map((tool) => tool.name),
    ["poll_messages", "health_check"],
  );
});

test("removes the upstream token from local schemas and required fields", () => {
  const upstream = selectCentralTools(catalog, true)[0];
  assert.ok(upstream !== undefined);
  const local = localToolDefinition(upstream);
  assert.deepEqual(local.inputSchema, {
    type: "object",
    properties: { timeout: { type: "number" } },
    required: [],
    additionalProperties: false,
  });
});

test("rejects credential selectors anywhere in projected schemas", () => {
  const schemas = [
    {
      type: "object",
      properties: {},
      required: ["jwt"],
    },
    {
      type: "object",
      properties: {},
      $defs: {
        auth: {
          type: "object",
          properties: { token: { type: "string" } },
        },
      },
    },
    {
      type: "object",
      properties: {},
      allOf: [
        {
          type: "object",
          properties: { agent_id: { type: "string" } },
        },
      ],
    },
    {
      type: "object",
      properties: {},
      allOf: [{ type: "object", required: ["jwt"] }],
    },
    {
      type: "object",
      properties: {},
      additionalProperties: {
        type: "object",
        properties: { credential: { type: "string" } },
      },
    },
    {
      type: "object",
      properties: {},
      items: [{ type: "string" }],
      additionalItems: { type: "object", required: ["jwt"] },
    },
  ];

  for (const inputSchema of schemas) {
    assert.throws(() => localToolDefinition({ name: "unsafe", inputSchema }), McpContractError);
  }
});

test("allows required as an ordinary argument name", () => {
  const tool = localToolDefinition({
    name: "safe",
    inputSchema: {
      type: "object",
      properties: {
        required: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          default: { required: "example data" },
        },
      },
      required: ["required"],
    },
  });

  assert.deepEqual(tool.inputSchema.required, ["required"]);
});

test("injects the central token exactly once only when the upstream schema requires it", () => {
  const [poll, health] = selectCentralTools(catalog, true);
  assert.ok(poll !== undefined && health !== undefined);
  assert.deepEqual(upstreamToolArguments(poll, { timeout: 0 }, JWT), {
    timeout: 0,
    token: JWT,
  });
  assert.deepEqual(upstreamToolArguments(health, {}, JWT), {});

  for (const selector of ["token", "jwt", "agent_id", "credential_id"]) {
    assert.throws(
      () => upstreamToolArguments(poll, { [selector]: "caller-value" }, JWT),
      McpContractError,
    );
  }
});

test("fails closed on credential-bearing nested results or stored JWT bytes", () => {
  for (const result of [
    { token: "unexpected" },
    { nested: { access_token: "unexpected" } },
    { items: [{ authorization: "unexpected" }] },
    { message: `prefix ${JWT} suffix` },
    { [JWT]: "unexpected property name" },
  ]) {
    assert.throws(() => assertSafeUpstreamResult(result, JWT), McpContractError);
  }
  assert.doesNotThrow(() => assertSafeUpstreamResult({ message: "safe" }, JWT));
  assert.doesNotThrow(() =>
    assertSafeUpstreamResult({ agent_id: "agent_fixture", credential_id: "public-reference" }, JWT),
  );
});

test("extracts one verification credential and discards safe response extensions", () => {
  const parsed = parseVerificationSuccess({
    agent_id: "agent_123",
    username: "fixture-agent",
    token: JWT,
    message: "Email verified successfully.",
  });
  assert.ok(parsed.token === JWT);
  assert.deepEqual(parsed.localResult, {
    verified: true,
    agent_id: "agent_123",
    username: "fixture-agent",
    message: "Email verified successfully.",
  });
  assert.ok(!JSON.stringify(parsed.localResult).includes(JWT));

  const withNote = parseVerificationSuccess({
    agent_id: "agent_123",
    username: "fixture-agent",
    token: JWT,
    message: "Email verified successfully.",
    note: "The gateway owns the issued credential.",
  });
  assert.deepEqual(withNote.localResult, parsed.localResult);
  assert.equal(Object.hasOwn(withNote.localResult, "note"), false);

  const withExtensions = parseVerificationSuccess({
    agent_id: "agent_123",
    username: "fixture-agent",
    token: JWT,
    message: "Email verified successfully.",
    note: "The gateway owns the issued credential.",
    central_version: 2,
    delivery: { status: "complete" },
  });
  assert.deepEqual(withExtensions.localResult, parsed.localResult);

  for (const invalid of [
    { agent_id: "agent_123", username: "fixture-agent", message: "missing token" },
    {
      agent_id: "agent_123",
      username: "fixture-agent",
      token: JWT,
      access_token: "second-token",
      message: "unexpected field",
    },
    { agent_id: "", username: "fixture-agent", token: JWT, message: "empty identity" },
    { agent_id: JWT, username: "fixture-agent", token: JWT, message: "unsafe identity" },
    { agent_id: "agent_123", username: `prefix-${JWT}`, token: JWT, message: "unsafe user" },
    { agent_id: "agent_123", username: "fixture-agent", token: JWT, message: JWT },
    {
      agent_id: "agent_123",
      username: "fixture-agent",
      token: JWT,
      message: "Email verified successfully.",
      note: `credential: ${JWT}`,
    },
    {
      agent_id: "agent_123",
      username: "fixture-agent",
      token: JWT,
      message: "Email verified successfully.",
      extra: { access_token: "second-token" },
    },
  ]) {
    assert.throws(() => parseVerificationSuccess(invalid), McpContractError);
  }
});
