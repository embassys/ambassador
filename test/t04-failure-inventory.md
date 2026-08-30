# T04 conversation-recovery inventory

Status: accepted gateway contract, green after G04

The user accepted this classified gateway inventory on 2026-08-30. It merged
through PR `#28`. Central S01 review and the S04/S05 server work remain
separate gates.

This file preserves the exact reviewed nodes in the `t04-*.test.ts` files.
Their local fixture evidence is green; it is not evidence about the production
central service. The target assumes a fresh install and contains no credential,
mailbox, or delivery-mode migration case.

Run the suite serially because the public gateway owns one fixed loopback
port:

```text
pnpm run test:build
node --test --test-concurrency=1 --test-reporter=spec \
  .test-dist/test/t04-*.test.js
```

The final `0.2.6` observation on 2026-08-29 was 40 red behavior checks and one
green response-observer support check. After G04, all 41 reviewed test nodes
are green. The inventory remains exact so a regression cannot silently change
the reviewed node identities.

| Test | Implemented boundary | Owner after review |
| --- | --- | --- |
| T04-P01 | REST enrollment persists a DPoP credential, activates v2, and begins leased receive without v1 poll. | G01 through G04 |
| T04-C01 | Fixed local start and content-free start-lookup projections preserve central idempotency. | G04 |
| T04-D01 | Activated REST receive redelivers one immutable leased message after restart. | G04 |
| T04-R01 | Reply routing and the reply idempotency key derive only from the current inbound ID. | G04 |
| T04-O01 | Every accepted terminal completion pair records idempotently before acknowledgement. | G04 |
| T04-O02 | The original sender observes a content-free terminal no-reply outcome. | G04 |
| T04-R02 | Outcome lookup resolves a lost reply response without a second outbound turn. | G04 |
| T04-A01 | A committed acknowledgement with a lost response repeats from the ID-only row. | G04 |
| T04-E01 | Authorization, anti-enumeration, and rate-limit errors remain fixed and non-reflecting. | G03 and G04 |
| T04-B01 | Local work is capped at eight calls and shutdown cancels a waiting poll. | G04 |
| T04-S01 | Quiescent artifacts and normal transcripts contain no credential or conversation content. | G04 |
| T04-V01 | Fresh-install activation repeats safely after a lost committed response. | G04 |
| T04-C02 | Start lookup resolves uncertainty; same input repeats and changed input conflicts. | G04 |
| T04-C03 | Strict start bounds reject locally before central application work. | G04 |
| T04-R03 | Same-text reply repetition returns one outbound ID; changed text conflicts. | G04 |
| T04-R04 | `mailbox_full` leaves the inbound turn open and buffered. | G04 |
| T04-O03 | Concurrent reply and completion produce exactly one terminal result. | G04 |
| T04-A02 | Ack requires terminal state and deletes the row only after the exact matching result. | G04 |
| T04-M02-* | Unknown keys, conflicting IDs, duplicate keys, and every receive size violation fail before admission. | G04 |
| T04-D06 | One central leased receive stays active while every local poll remains local. | G04 |
| T04-D07 | The exact 524,288-byte, 100-message boundary preserves order. | G04 |
| T04-V05 | Conversation lifecycle traffic uses fixed REST routes, rejects redirects, and never falls back to central MCP message tools. | G04 |
| T04-E02 | DPoP challenges remain distinct from nested application errors and reflect no challenge data. | G03 and G04 |
| T04-X-startup | A pre-start crash leaves no partial work and restarts with the same opaque request ID. | G01 through G04 |
| T04-X-readiness | A post-readiness crash restarts without bearer fallback or v1 consuming poll. | G01 through G04 |
| T04-X-operation | A pre-dispatch crash safely reuses the same opaque request ID. | G04 |
| T04-X-commit | A dropped committed start resolves to the one recorded conversation after restart. | G04 |
| T04-X-response | A post-response crash preserves central idempotency without durable request content. | G04 |
| T04-X-teardown | Interrupted teardown releases ownership and recovers with the same operation ID. | G04 |
| T04-X-start-commit | A held committed start recovers one conversation after process kill. | G04 |
| T04-X-receive-commit | A held committed receive redelivers the immutable message after lease expiry. | G04 |
| T04-X-reply-commit | A held committed reply recovers the one recorded reply without replaying content. | G04 |
| T04-X-complete-commit | A held committed completion recovers the one terminal outcome. | G04 |
| T04-X-ack-commit | A held committed acknowledgement recovers from the ID-only tombstone path. | G04 |

The full-process conversation-start crash matrix uses all six merged T02
barriers: startup, readiness, operation, commit, response, and teardown. Each
case reuses the same opaque request ID after restart. The commit case uses the
fixture's drop-after-commit control. Every case runs the T02 artifact scanner
only after the complete child process group has stopped. D01, R02, O01, A01,
and A02 separately specify receive, reply, completion, and acknowledgement
recovery against the real gateway boundary.

The T04 response observer adds five exact full-process commit boundaries. It
lets the real central request commit, then holds the response before the
gateway's `fetch` resolves. The test kills the gateway process group while the
response is held and restarts from the same content-free state. No external
observer can pause the in-process SQLite journal transaction between commit and
the wake loop without a gateway hook. That journal-to-wake micro-boundary
remains explicit rather than being represented by the worker barriers.

`T04 support holds a completed upstream response until explicit release` is a
green harness self-test. It proves that the preload observes the completed
upstream response and withholds it from the gateway child until release; it is
not a production-behavior failure.

Provider process restart, provider approval waiting, and provider-turn replay
belong to the connector red suite after ADR 0024 and D05. T04 covers only the
gateway's central message lifecycle and ID-only durability.
