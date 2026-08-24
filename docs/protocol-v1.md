# Sidecar protocol v1

Status: accepted under delegated approval, user review pending

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
- One `delivery_id` maps to one `notification_id` in v1. A different notification ID for the same delivery is a protocol error.
- Exact duplicates in one poll batch are coalesced and produce one stored notification and one acknowledgement.
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
  "sequence": 1,
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
| `uncertain` | `expired_after_attempt`, `retry_window_exhausted`, `binding_changed` |

`accepted` and `expired` omit `reason`. Only `retrying` includes `next_attempt_at`.

The sidecar writes each report to its outbox before sending it. A retry keeps the same `report_id`. The controller treats a repeated report ID as success and rejects a reused report ID with different fields.

`sequence` starts at `1` and increases for each new report about a notification. The controller applies only a sequence greater than the last one it accepted. It treats an older sequence as an idempotent stale report, and rejects a different report ID that reuses an accepted sequence. This prevents a delayed `retrying` report from replacing a later `accepted` report.

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

The daemon holds a single-instance lock, and the journal claims due deliveries atomically. A second process must fail before it polls or wakes a runtime.

The sidecar pins the binding configuration used for the first attempt. If that configuration changes after an uncertain outcome, the sidecar does not send the same delivery to a different runtime. It reports `uncertain` with reason `binding_changed`.

`accepted`, `failed`, `expired`, and `uncertain` are terminal sidecar states. Task completion is not a sidecar state.

Version 1 never reopens `failed` automatically. After the operator fixes configuration or credentials, the controller must issue a new delivery ID.

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
- Do not retry a permanent error. A corrected setup requires a new delivery ID in v1.
- Do not start a new attempt after `expires_at`.
- An `accepted` response wins even if it arrives after `expires_at`.
- A permanent error received after expiry remains `failed`.
- Report `expired` if no attempt may have reached the runtime before the retry window closes.
- Report `uncertain` if an earlier attempt may have reached the runtime but the retry window closes.
- Stop polling when the durable local queue reaches its configured limit. Resume after it drains.
- If a poll response would exceed queue capacity, commit none of that response, keep the old cursor, and send no acknowledgements.
- Do not delete a notification, session mapping, or outbox row before the controller confirms its final report and the runtime's duplicate window has passed.

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
| P06 | New notification ID reuses a delivery ID | Reject it as a protocol violation |
| P07 | Exact duplicate appears twice in one batch | Store and acknowledge it once |
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
| W09 | Binding changes after an uncertain attempt | Do not route to the new runtime; report `binding_changed` |
| O01 | Controller is unavailable after wake acceptance | Keep and retry the accepted report |
| O02 | Repeated report ID | Controller returns success without applying it twice |
| O03 | Older report arrives after a newer sequence | Controller accepts it as stale without changing state |
| C01 | A second daemon starts on the same journal | It exits before polling or waking |
| C02 | Poll batch would exceed queue capacity | Store none of it and keep the old cursor |
| S01 | Secret appears in an error or response | Redact it before logs or diagnostics are written |
| S02 | Generic webhook has a bad signature or stale timestamp | Runtime rejects it without starting an agent session |
| D01 | Inspect network, journal, logs, and diagnostics | Find no forbidden task or MCP fields |

## Operating decisions

ADR `0009-operating-defaults.md` records the provisional values used by the implementation. Controller-managed credential issuance, OS credential vaults, and bounded journal cleanup remain deferred until their external contracts are available.
