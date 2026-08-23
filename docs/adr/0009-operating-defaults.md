# 0009 Operating defaults

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The protocol left webhook encoding, retry timing, poll bounds, credential lifecycle, and journal retention open. Tests and production code need concrete values.

## Decision

The generic webhook uses the same HMAC format as the qualified Hermes webhook:

```text
X-Webhook-Timestamp: <Unix seconds>
X-Webhook-Signature-V2: <lowercase hex HMAC-SHA256>
```

The signed bytes are `<timestamp>.<exact request body>`. The receiver rejects timestamps more than 300 seconds from its clock and compares signatures without timing leaks.

Use a one-second retry base and a 60-second cap. When the runtime supplies no delay, use equal jitter between half and all of the capped exponential delay. The delivery's `expires_at` is the retry deadline. The sidecar never schedules a retry past that timestamp.

Configuration accepts poll waits from 1 to 300 seconds, batch sizes from 1 to 1,000 notifications, and queue capacities from 1 to 1,000,000 active deliveries. Defaults remain 30 seconds, 50 notifications, and 1,000 active deliveries.

V1 reads an externally issued installation token from an environment reference. Automatic issuance and refresh remain deferred until the controller defines them.

V1 does not delete delivery rows. Confirmed outbox rows are marked with a confirmation timestamp and omitted from sends. A later retention migration may delete terminal rows only after it has a runtime duplicate-window value for each adapter.

## Costs

Keeping delivery history indefinitely can grow the database. This is safer than deleting idempotency records too early, but a retention policy is required before a long-running public release.

Environment-only credentials are awkward for desktop startup. OS credential vault support remains required before public beta.

## Compatibility

The webhook headers match Hermes V2. A generic receiver can use the same verification code. Other runtimes may use native authentication inside their adapters.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
