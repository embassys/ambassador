import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePollResponse, parseWakeResponse } from "../src/protocol.js";

const notification = {
  notification_id: "notice_01J6YR",
  delivery_id: "delivery_01J6YP",
  binding_id: "binding_hermes",
  issued_at: "2026-08-23T11:59:58Z",
  expires_at: "2026-08-23T12:09:58Z",
};

const pollResponse = {
  protocol_version: 1,
  cursor: "cursor_01J6YR",
  server_time: "2026-08-23T12:00:00Z",
  notifications: [notification],
};

function assertProtocolError(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    return error.name !== "NotImplementedError";
  });
}

test("parsePollResponse accepts a strict valid response", () => {
  assert.deepEqual(parsePollResponse(pollResponse), pollResponse);
});

test("parsePollResponse validates versions, IDs, and UTC timestamps", () => {
  const invalidResponses = [
    { ...pollResponse, protocol_version: 2 },
    { ...pollResponse, cursor: "contains a space" },
    {
      ...pollResponse,
      notifications: [{ ...notification, notification_id: "" }],
    },
    {
      ...pollResponse,
      notifications: [{ ...notification, delivery_id: "x".repeat(129) }],
    },
    { ...pollResponse, server_time: "2026-08-23T12:00:00+00:00" },
    {
      ...pollResponse,
      notifications: [{ ...notification, issued_at: "2026-08-23 11:59:58Z" }],
    },
  ];

  for (const response of invalidResponses) {
    assertProtocolError(() => parsePollResponse(response));
  }
});

test("parsePollResponse rejects unknown and forbidden fields at every level", () => {
  const invalidResponses = [
    { ...pollResponse, future_field: true },
    {
      ...pollResponse,
      notifications: [{ ...notification, future_field: true }],
    },
    { ...pollResponse, task: "must not reach the sidecar" },
    {
      ...pollResponse,
      notifications: [{ ...notification, mcp_payload: { method: "claim" } }],
    },
  ];

  for (const response of invalidResponses) {
    assertProtocolError(() => parsePollResponse(response));
  }
});

test("parsePollResponse coalesces exact duplicates in one batch", () => {
  const parsed = parsePollResponse({
    ...pollResponse,
    notifications: [notification, structuredClone(notification)],
  });

  assert.deepEqual(parsed.notifications, [notification]);
});

test("parsePollResponse rejects conflicting notification and delivery IDs", () => {
  const conflicts = [
    [notification, { ...notification, binding_id: "binding_openclaw" }],
    [notification, { ...notification, notification_id: "notice_01J6YS" }],
  ];

  for (const notifications of conflicts) {
    assertProtocolError(() => parsePollResponse({ ...pollResponse, notifications }));
  }
});

test("parseWakeResponse accepts each valid status shape", () => {
  const responses = [
    { protocol_version: 1, status: "accepted" },
    {
      protocol_version: 1,
      status: "duplicate",
      session_id: "local-session-42",
    },
    {
      protocol_version: 1,
      status: "retryable_error",
      code: "rate_limited",
      retry_after_ms: 5_000,
    },
    {
      protocol_version: 1,
      status: "permanent_error",
      code: "unauthorized",
    },
  ];

  for (const response of responses) {
    assert.deepEqual(parseWakeResponse(response), response);
  }
});

test("parseWakeResponse enforces status-specific fields", () => {
  const invalidResponses = [
    { protocol_version: 1, status: "accepted", code: "unexpected" },
    {
      protocol_version: 1,
      status: "duplicate",
      retry_after_ms: 1_000,
    },
    { protocol_version: 1, status: "retryable_error" },
    {
      protocol_version: 1,
      status: "retryable_error",
      code: "timeout",
      retry_after_ms: -1,
    },
    {
      protocol_version: 1,
      status: "permanent_error",
      code: "unauthorized",
      retry_after_ms: 1_000,
    },
    { protocol_version: 1, status: "unknown" },
  ];

  for (const response of invalidResponses) {
    assertProtocolError(() => parseWakeResponse(response));
  }
});

test("parseWakeResponse rejects unsupported versions and free-text fields", () => {
  assertProtocolError(() => parseWakeResponse({ protocol_version: 2, status: "accepted" }));
  assertProtocolError(() =>
    parseWakeResponse({
      protocol_version: 1,
      status: "permanent_error",
      code: "rejected",
      message: "runtime supplied details",
    }),
  );
});
