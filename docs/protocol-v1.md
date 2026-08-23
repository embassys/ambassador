# Sidecar protocol v1

Status: draft for user review

This document defines behavior, not HTTP paths or implementation libraries. The controller team may map the controller operations to its own API. Runtime adapters map the wake contract to each runtime's API.

## Scope

Version 1 handles one wake command for each delivery. A retry may resume the session already associated with that delivery, but v1 has no separate later resume or cancel command.

The sidecar receives IDs and timing metadata only. The agent gets task content directly from the central MCP endpoint after it wakes.

## Terms

| Name | Meaning |
| --- | --- |
| Installation | One sidecar registered to one OS user |
| Binding | A controller ID mapped to one local runtime configuration |
| Notification | The controller's instruction to wake a binding |
| Delivery | One logical agent task and its local runtime session |
| Cursor | The sidecar's durable position in the notification stream |
| Wake report | The sidecar's report of the local handoff result |

## Protocol rules

- All messages use protocol version `1`.
- Messages reject unknown fields. Version changes, not ignored fields, handle future extensions.
- IDs are opaque and case-sensitive. They use 1 to 128 URI-unreserved ASCII characters: letters, digits, `.`, `_`, `~`, and `-`.
- Timestamps use RFC 3339 UTC with a `Z` suffix.
- The controller sends the same `notification_id`, `delivery_id`, and `binding_id` when it redelivers a notification.
- The sidecar uses `delivery_id` as the runtime wake idempotency key.
- Different payloads with the same ID are a protocol error.
- The sidecar never sends a local runtime session ID to the controller.
- No protocol message has a free-text prompt, result, or error field.

## Controller operations

The controller exposes three logical operations: poll notifications, acknowledge persistence, and report a wake result.

### Poll notifications

Request:

```json
{
  "protocol_version": 1,
  "cursor": "cursor_01J6YQ",
  "wait_seconds": 30,
  "max_notifications": 50
}
```

`cursor` is `null` on the first poll. The controller sets the allowed bounds for `wait_seconds` and `max_notifications`.

Response:

```json
{
  "protocol_version": 1,
  "cursor": "cursor_01J6YR",
  "server_time": "2026-08-23T12:00:00Z",
  "notifications": [
    {
      "notification_id": "notice_01J6YR",
      "delivery_id": "delivery_01J6YP",
      "binding_id": "binding_hermes",
      "issued_at": "2026-08-23T11:59:58Z",
      "expires_at": "2026-08-23T12:09:58Z"
    }
  ]
}
```

The sidecar validates the full response, then records all notifications and the new cursor in one transaction. If validation or storage fails, it keeps the old cursor and acknowledges nothing from that response.

An empty response may advance the cursor. The sidecar stores that cursor before using it on the next poll.

### Acknowledge persistence

The sidecar sends this only after the notification and cursor commit:

```json
{
  "protocol_version": 1,
  "notification_id": "notice_01J6YR",
  "delivery_id": "delivery_01J6YP",
  "status": "persisted",
  "persisted_at": "2026-08-23T12:00:01Z"
}
```

The controller treats repeated acknowledgements for the same notification as success. An acknowledgement does not mean the runtime woke. It means the sidecar can recover the notification after a crash.

### Report the wake result

```json
{
  "protocol_version": 1,
  "report_id": "report_01J6YS",
  "notification_id": "notice_01J6YR",
  "delivery_id": "delivery_01J6YP",
  "status": "retrying",
  "reason": "runtime_unavailable",
  "observed_at": "2026-08-23T12:00:02Z",
  "next_attempt_at": "2026-08-23T12:00:07Z"
}
```

Allowed statuses:

| Status | Meaning |
| --- | --- |
| `accepted` | The runtime accepted the wake or confirmed a duplicate |
| `retrying` | The sidecar will try the same `delivery_id` again |
| `failed` | A permanent local error prevents the wake |
| `expired` | The delivery expired before any wake could be accepted |
| `uncertain` | A request may have reached the runtime, but the sidecar can no longer retry safely |

Allowed reasons:

| Status | Reasons |
| --- | --- |
| `retrying` | `runtime_unavailable`, `rate_limited`, `timeout`, `outcome_unknown` |
| `failed` | `binding_not_found`, `unauthorized`, `invalid_config`, `unsupported_runtime`, `rejected` |
| `uncertain` | `expired_after_attempt`, `retry_window_exhausted` |

`accepted` and `expired` omit `reason`. Only `retrying` includes `next_attempt_at`.

The sidecar writes each report to its outbox before sending it. A retry keeps the same `report_id`. The controller treats a repeated report ID as success and rejects a reused report ID with different fields.

## Runtime wake contract

The internal adapter request contains only:

```json
{
  "protocol_version": 1,
  "delivery_id": "delivery_01J6YP",
  "sent_at": "2026-08-23T12:00:02Z"
}
```

The adapter may turn this into a runtime-specific fixed instruction. The only variable content in that instruction is `delivery_id`. It must not include controller credentials, task data, permission data, or a caller-supplied prompt.

The normalized adapter response is one of:

```json
{
  "protocol_version": 1,
  "status": "accepted",
  "session_id": "local-session-42"
}
```

```json
{
  "protocol_version": 1,
  "status": "duplicate",
  "session_id": "local-session-42"
}
```

```json
{
  "protocol_version": 1,
  "status": "retryable_error",
  "code": "rate_limited",
  "retry_after_ms": 5000
}
```

```json
{
  "protocol_version": 1,
  "status": "permanent_error",
  "code": "unauthorized"
}
```

`session_id` is optional, opaque, and local to the sidecar. `retry_after_ms` appears only for `retryable_error`. Responses contain no free-text error message.

The generic webhook signs the timestamp and exact request bytes with a per-binding HMAC secret. The receiver checks the signature and rejects timestamps outside a five-minute window. Product-specific adapters may use the runtime's native authentication instead.

A production adapter must make duplicate handling durable before it reports `accepted`. It must map repeated uses of a `delivery_id` to the same session across process restarts and for at least the controller's retry window. An adapter that cannot do this is marked best-effort and cannot claim one session per delivery.

Local endpoints bind to loopback by default. A non-loopback endpoint requires TLS and explicit user configuration.

## Delivery state

```text
pending -> waking -> accepted
   |          |
   |          +-> retry_wait -> waking
   |          +-> failed
   |          +-> uncertain
   |
   +-> expired
```

The sidecar records `waking` before calling the runtime. Only one wake attempt for a delivery runs at a time. Different deliveries may run concurrently, and the protocol promises no ordering between them.

`accepted`, `failed`, `expired`, and `uncertain` are terminal sidecar states. Task completion is not a sidecar state.

## Crash behavior

| Crash point | Recovery |
| --- | --- |
| Before notification commit | Poll again with the old cursor |
| After commit, before persistence acknowledgement | Resend the acknowledgement |
| During a wake request | Treat the outcome as unknown and retry the same `delivery_id` |
| After runtime acceptance, before local result commit | Retry the same `delivery_id`; the runtime must deduplicate or resume |
| After report commit, before controller confirmation | Resend the same `report_id` |

The protocol provides at-least-once wake delivery. It does not claim exactly-once model execution. That requires durable deduplication in the runtime.

## Retry and expiry

- Retry runtime unavailability, rate limits, timeouts, and unknown outcomes.
- Honor a valid runtime or controller retry delay.
- Use bounded exponential backoff with jitter when no delay is supplied. Exact timing remains a later implementation decision.
- Do not retry a permanent error until configuration or credentials change.
- Do not start a new attempt after `expires_at`.
- Report `expired` if no attempt may have reached the runtime.
- Report `uncertain` if an earlier attempt may have reached the runtime but the retry window closes.
- Stop polling when the durable local queue reaches its configured limit. Resume after it drains.

The sidecar uses `server_time` to estimate controller clock offset for expiry checks. `doctor` reports unsafe clock skew.

## Authentication assumptions

- Controller traffic uses TLS and an installation-scoped credential.
- The controller derives installation identity from that credential, not from a caller-supplied message field.
- Credentials never appear in URLs, message bodies, logs, or the local journal.
- Credential issuance and refresh are owned by the controller and remain open for user review.
- A local generic webhook uses one secret per binding. Native adapters use the narrowest credential the runtime supports.

## Data boundary

Allowed fields are the ones shown in this document. The sidecar may also keep attempt counts, scheduling timestamps, cursor state, and local session mappings in its journal.

Reject any controller or runtime message containing fields such as `task`, `prompt`, `message`, `content`, `attachment`, `response`, `result`, `permission`, `grant`, `tool_call`, or `mcp_payload`.

## Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| P01 | Valid poll response | Store the batch and cursor atomically |
| P02 | Unknown field or forbidden content | Reject the full response and keep the old cursor |
| P03 | Unsupported protocol version | Fail closed and report a version error locally |
| P04 | Conflicting payload for an existing ID | Stop processing and report a protocol violation locally |
| P05 | Empty poll response | Store its cursor and poll again |
| A01 | Crash before notification commit | Controller redelivery is processed normally |
| A02 | Crash after commit but before acknowledgement | Sidecar resends the persistence acknowledgement |
| A03 | Repeated acknowledgement | Controller returns success without changing delivery state |
| W01 | First wake | Runtime receives only the fixed instruction and `delivery_id` |
| W02 | Duplicate notification | At most one wake attempt runs at a time for that delivery |
| W03 | Uncertain wake outcome | Retry uses the same `delivery_id` |
| W04 | Runtime reports duplicate | Normalize it to controller status `accepted` |
| W05 | Runtime rate limit | Honor `retry_after_ms` and report `retrying` |
| W06 | Permanent runtime rejection | Do not retry and report `failed` |
| W07 | Delivery expires before an attempt | Do not call the runtime and report `expired` |
| W08 | Delivery expires after an uncertain attempt | Do not call again and report `uncertain` |
| O01 | Controller is unavailable after wake acceptance | Keep and retry the accepted report |
| O02 | Repeated report ID | Controller returns success without applying it twice |
| S01 | Secret appears in an error or response | Redact it before logs or diagnostics are written |
| S02 | Generic webhook has a bad signature or stale timestamp | Runtime rejects it without starting an agent session |
| D01 | Inspect network, journal, logs, and diagnostics | Find no forbidden task or MCP fields |

## Open decisions

The user must approve these before tests or implementation lock them in:

- Controller credential issuance and refresh.
- Poll wait and batch-size limits.
- Default retry timing and maximum retry window.
- Local journal retention.
- Generic webhook header names and exact signature encoding.
