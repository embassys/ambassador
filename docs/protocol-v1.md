# Gateway relay protocol v1

Status: accepted under delegated approval, user review pending

This document defines the durable notification and wake behavior, not implementation libraries. The controller team may map the logical operations to its own API. Runtime adapters map the wake contract to each runtime's API. ADR `0016-combined-gateway-mcp-proxy.md` separately allows the same process to proxy MCP calls.

## Scope

Version 1 handles one wake command for each delivery. A retry may resume the session already associated with that delivery, but v1 has no separate later resume or cancel command.

The notification relay receives IDs and timing metadata only. After it wakes, the agent calls the combined process's authenticated loopback MCP proxy. MCP content may pass transiently through that proxy but is outside the relay state machine and durable journal.

## Terms

| Name | Meaning |
| --- | --- |
| Installation | One gateway registered to one OS user |
| Binding | A controller ID mapped to one local runtime configuration |
| Notification | The controller's instruction to wake a binding |
| Delivery | One logical agent task and its local runtime session |
| Cursor | The gateway's durable position in the notification stream |
| Wake report | The gateway's report of the local handoff result |
| Local MCP proxy | Authenticated loopback interface that injects a binding's central JWT into upstream MCP calls |

## Protocol rules

- All messages use protocol version `1`.
- Notification, acknowledgement, wake-report, and runtime-wake messages reject unknown fields. Version changes, not ignored fields, handle future relay extensions.
- IDs are opaque and case-sensitive. They use 1 to 128 URI-unreserved ASCII characters: letters, digits, `.`, `_`, `~`, and `-`.
- Timestamps use RFC 3339 UTC with a `Z` suffix.
- The controller sends the same `notification_id`, `delivery_id`, and `binding_id` when it redelivers a notification.
- One `delivery_id` maps to one `notification_id` in v1. A different notification ID for the same delivery is a protocol error.
- Exact duplicates in one poll batch are coalesced and produce one stored notification and one acknowledgement.
- The gateway uses `delivery_id` as the runtime wake idempotency key.
- Different payloads with the same ID are a protocol error.
- The gateway never sends a local runtime session ID to the controller.
- No relay protocol message has a free-text prompt, result, or error field. MCP tool messages are not relay protocol messages.

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

The gateway validates the full response, then records all notifications and the new cursor in one transaction. If validation or storage fails, it keeps the old cursor and acknowledges nothing from that response.

An empty response may advance the cursor. The gateway stores that cursor before using it on the next poll.

### Acknowledge persistence

The gateway sends this only after the notification and cursor commit:

```json
{
  "protocol_version": 1,
  "notification_id": "notice_01J6YR",
  "delivery_id": "delivery_01J6YP",
  "status": "persisted",
  "persisted_at": "2026-08-23T12:00:01Z"
}
```

The controller treats repeated acknowledgements for the same notification as success. An acknowledgement does not mean the runtime woke. It means the gateway can recover the notification after a crash.

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
| `retrying` | The gateway will try the same `delivery_id` again |
| `failed` | A permanent local error prevents the wake |
| `expired` | The delivery expired before any wake could be accepted |
| `uncertain` | A request may have reached the runtime, but the gateway can no longer retry safely |

Allowed reasons:

| Status | Reasons |
| --- | --- |
| `retrying` | `runtime_unavailable`, `rate_limited`, `timeout`, `outcome_unknown` |
| `failed` | `binding_not_found`, `unauthorized`, `invalid_config`, `unsupported_runtime`, `rejected` |
| `uncertain` | `expired_after_attempt`, `retry_window_exhausted`, `binding_changed` |

`accepted` and `expired` omit `reason`. Only `retrying` includes `next_attempt_at`.

The gateway writes each report to its outbox before sending it. A retry keeps the same `report_id`. The controller treats a repeated report ID as success and rejects a reused report ID with different fields.

`sequence` starts at `1` and increases for each new report about a notification. The controller applies only a sequence greater than the last one it accepted. It treats an older sequence as an idempotent stale report, and rejects a different report ID that reuses an accepted sequence. This prevents a delayed `retrying` report from replacing a later `accepted` report.

## Short-term central compatibility

ADR `0016-combined-gateway-mcp-proxy.md` uses the available central API as an interim mapping:

```text
GET  /api/poll_messages?timeout=<seconds>
POST /api/ack_message
```

One poll runs for each configured binding with that binding's central agent JWT. The poll context implies `binding_id`. The short-term response is assumed to contain only opaque IDs:

```json
{"messages":[{"id":"delivery_01J6YP"}]}
```

The gateway treats `id` as both `notification_id` and `delivery_id`. The acknowledgement request uses `{"message_id":"delivery_01J6YP"}`.

This interim mapping requires message IDs to be globally unique across every JWT-scoped poll stream because the same value is also the runtime wake idempotency key. If the controller guarantees uniqueness only within one agent stream, integration must wait for a separately approved namespacing design covering journal keys, acknowledgement mapping, and runtime wake IDs. The compatibility contract must also define per-binding poll state, acknowledgement ownership, backpressure, and failure isolation.

The inspected central implementation marks a message delivered during polling and does not redeliver it or accept repeated acknowledgements. It also omits cursor, expiry, server-time, and wake-report operations. It therefore does not yet satisfy the durable v1 contract. Controller integration must add those semantics; the gateway must not claim crash-safe delivery against the current behavior.

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

`session_id` is optional, opaque, and local to the gateway. `retry_after_ms` appears only for `retryable_error`. Responses contain no free-text error message.

The generic webhook signs the timestamp and exact request bytes with a per-binding HMAC secret. The receiver checks the signature and rejects timestamps outside a five-minute window. Product-specific adapters may use the runtime's native authentication instead.

A production adapter must make duplicate handling durable before it reports `accepted`. It must map repeated uses of a `delivery_id` to the same session across process restarts and for at least the controller's retry window. An adapter that cannot do this is marked best-effort and cannot claim one session per delivery.

Runtime wake endpoints bind to loopback by default. A non-loopback runtime endpoint requires TLS and explicit user configuration. The gateway's MCP endpoint always binds to loopback.

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

The gateway records `waking` before calling the runtime. Only one wake attempt for a delivery runs at a time. Different deliveries may run concurrently, and the protocol promises no ordering between them.

The daemon holds a single-instance lock, and the journal claims due deliveries atomically. A second process must fail before it resolves central JWTs, polls, binds the MCP listener, forwards a tool call, or wakes a runtime.

The gateway pins the binding configuration used for the first attempt. If that configuration changes after an uncertain outcome, the gateway does not send the same delivery to a different runtime. It reports `uncertain` with reason `binding_changed`.

`accepted`, `failed`, `expired`, and `uncertain` are terminal gateway relay states. Task completion is not a relay state.

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

The gateway uses `server_time` to estimate controller clock offset for expiry checks. `doctor` reports unsafe clock skew.

## Authentication assumptions

- Central traffic uses TLS. In the interim design, each binding references one central agent JWT used for both that binding's poll stream and proxied MCP calls.
- The local MCP endpoint authenticates callers separately and maps each authenticated caller to one fixed binding. Tool arguments cannot select a binding or central JWT.
- Central JWTs never appear in URLs, MCP tool arguments, tool results, logs, or the local journal.
- Configuration stores credential references, not JWT values. Credential issuance, refresh, and OS-vault storage remain open for review.
- A future controller may replace central agent JWT polling with a restricted installation credential and a binding-aware notification stream.
- A local generic webhook uses one secret per binding. Native adapters use the narrowest credential the runtime supports.

## Data boundary

Allowed relay fields are the ones shown in this document. The gateway may also keep attempt counts, scheduling timestamps, cursor state, and local session mappings in its journal.

Reject any notification or runtime-wake message containing fields such as `task`, `prompt`, `message`, `content`, `attachment`, `response`, `result`, `permission`, `grant`, `tool_call`, or `mcp_payload`.

The local MCP proxy may transiently process those fields when they are valid tool inputs or outputs. It must not place them in configuration, the relay journal, the durable outbox, diagnostics, metrics, or logs.

The proxy does not spool request or response bodies. Core dumps, minidumps, heap snapshots, crash reports, and support bundles count as durable outputs and must not capture MCP bodies or central JWT values.

## Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| P01 | Valid poll response | Store the batch and cursor atomically |
| P02 | Unknown notification field or forbidden relay content | Reject the full response and keep the old cursor |
| P03 | Unsupported protocol version | Fail closed and report a version error locally |
| P04 | Conflicting payload for an existing ID | Stop processing and report a protocol violation locally |
| P05 | Empty poll response | Store its cursor and poll again |
| P06 | New notification ID reuses a delivery ID | Reject it as a protocol violation |
| P07 | Exact duplicate appears twice in one batch | Store and acknowledge it once |
| A01 | Crash before notification commit | Controller redelivery is processed normally |
| A02 | Crash after commit but before acknowledgement | Gateway resends the persistence acknowledgement |
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
| D01 | Inspect relay requests, journal, logs, and diagnostics | Find no task, permission, result, tool-argument, or MCP body fields |
| M01 | Agent calls an authenticated local MCP tool | Proxy injects the caller's fixed binding JWT; the tool schema has no JWT argument |
| M02 | Unauthenticated local MCP call | Reject before forwarding anything centrally |
| M03 | Caller supplies another binding or credential in request data | Reject without resolving or using that binding's JWT |
| M04 | MCP request or response contains task or permission content | Forward transiently without writing it to durable state, diagnostics, metrics, or logs |
| M05 | MCP proxy crashes during a tool call | Retain no request or response body for replay |
| M06 | Timeout or disconnect after a side-effecting tool may reach the central service | Do not retry automatically; return the approved safe uncertain-outcome error |
| M07 | A second gateway starts | Fail before resolving JWTs, polling, binding the MCP listener, forwarding tools, or waking a runtime |

## Operating decisions

ADR `0009-operating-defaults.md` records the provisional relay values used by the current implementation. ADR `0016-combined-gateway-mcp-proxy.md` supersedes its installation-token assumption for the interim combined process. Local MCP authentication, central credential issuance, OS credential vaults, and bounded journal cleanup remain deferred until their contracts are approved.
