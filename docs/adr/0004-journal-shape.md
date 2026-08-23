# 0004 Journal shape

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The sidecar needs crash recovery without creating a place where task content can leak. A generic event or payload table would weaken that boundary.

## Options

- Store serialized protocol messages. This is convenient but can retain fields the sidecar should reject.
- Store only typed columns required by the state machine. This takes more migration work but makes the data boundary visible in the schema.
- Keep state in memory and rely on controller redelivery. This loses persistence acknowledgements, retry state, and local session mappings after a crash.

## Decision

Use three small groups of typed records:

| Record | Fields |
| --- | --- |
| Sidecar state | Schema version, poll cursor, and controller clock offset |
| Delivery | Notification, delivery, and binding IDs; pinned binding fingerprint; timestamps; state; attempt count; next attempt; local session ID; report sequence |
| Outbox | Ack or report ID; typed status and reason; timestamps; send attempts; controller confirmation |

Do not add generic JSON, body, payload, prompt, response, permission, or MCP columns.

The notification ID is unique, and the delivery ID is also unique in v1. State transitions and their outbox writes happen in one transaction. Due deliveries are claimed atomically.

Keep a stable acknowledgement timestamp across retries. Keep a report's ID, sequence, and fields unchanged until the controller confirms it.

Do not delete terminal delivery or outbox records until the controller has confirmed the terminal report and the runtime duplicate window has passed.

## Costs

Protocol changes may need a schema migration instead of writing a new JSON shape. That cost is intentional because it forces a data-boundary review.

## Storage implementation

This ADR does not select a database or library. That choice is recorded separately.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
