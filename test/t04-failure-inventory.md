# T04 red-suite failure inventory

Status: intentionally red pending the gateway review gate

This file classifies the expected failures in the `t04-*.test.ts` files.
Fixture contract tests are already green. A failure below therefore records an
observable gateway gap, not evidence about the production central service.
The target assumes a fresh install. It contains no credential, mailbox, or
delivery-mode migration case.

Run the suite serially because the public gateway owns one fixed loopback
port:

```text
pnpm run test:build
node --test --test-concurrency=1 --test-reporter=spec \
  .test-dist/test/t04-*.test.js
```

Final `0.2.6` observation on 2026-08-29: 41 behavior checks, of which 40 are
red and the response-observer support check is green. Unlike T03, T04 has no
parameterized parent nodes, so Node also reports 41 test nodes: 40 failed and
one passed.

| Test | Expected current failure | Owner after review |
| --- | --- | --- |
| T04-P01 | Gateway forwards enrollment through central MCP, stores a version 1 bearer credential, and starts the consuming version 1 poll. This is the shared G01 through G03 prerequisite. | G01, G02, G03, then G04 activation |
| T04-C01 | The local catalog has no `start_conversation` or `get_conversation_start` projection. | G04 |
| T04-D01 | The gateway has no activated REST v2 receive loop, lease redelivery, or restart recovery for an immutable full message. | G04 |
| T04-R01 | The gateway has no local reply projection or derived REST reply request. | G04 |
| T04-O01 | The gateway has no terminal completion projection or idempotent completion handling. | G04 |
| T04-O02 | The original sender cannot inspect a terminal no-reply outcome through the gateway. | G04 |
| T04-R02 | The gateway cannot resolve a lost reply response without creating another outbound turn. | G04 |
| T04-A01 | The gateway cannot repeat a committed acknowledgement after its response is lost. | G04 |
| T04-E01 | Version 2 authorization, anti-enumeration, and rate-limit inputs cannot yet be checked for non-reflection. | G03 and G04 |
| T04-B01 | Version 2 receive work is absent, so its concurrency, cancellation, and shutdown behavior cannot run. | G04 |
| T04-S01 | Version 2 message and completion paths are absent, so their quiescent artifact and transcript scan cannot run. | G04 |
| T04-V01 | Fresh-install activation does not exist and cannot repeat after a lost committed response. | G04 |
| T04-C02 | Uncertain start lookup, safe same-ID repeat, and changed-input conflict are absent. | G04 |
| T04-C03 | The gateway has no strict local v2 start projection or pre-dispatch bounds. | G04 |
| T04-R03 | Reply retry and changed-text conflict behavior are absent. | G04 |
| T04-R04 | A synthetic exact `mailbox_full` response cannot yet prove that the gateway preserves the open buffered turn. | G04 |
| T04-O03 | Reply and completion cannot race through one atomic terminal result. | G04 |
| T04-A02 | The gateway cannot enforce terminal-before-ack, retain the journal row after a mismatched acknowledgement result, or delete it only after the exact result. | G04 |
| T04-M02-* | The gateway cannot reject unknown, conflicting-duplicate-ID, duplicate-key, oversized-text, exact 524,289-byte, and over-4-MiB strict receive results before journal or inbox admission. | G04 |
| T04-D06 | The gateway cannot prove one active central receive while every local poll remains local. | G04 |
| T04-D07 | The gateway cannot accept a strict 100-message response at exactly 524,288 bytes without reordering it in the local inbox. | G04 |
| T04-V05 | The gateway does not use only the fixed REST receive and start routes or reject a redirect before its target is requested. | G04 |
| T04-E02 | The gateway cannot keep a DPoP challenge distinct from a nested application error without reflecting challenge data. | G03 and G04 |
| T04-X-startup | A crash before gateway startup must leave no partial durable work; restart is currently blocked at the missing v2 catalog. | G01 through G04 |
| T04-X-readiness | A crash after listener readiness must restart without using a bearer credential or consuming poll. | G01 through G04 |
| T04-X-operation | A crash before side-effect dispatch must allow the caller to reuse its opaque request ID. | G04 |
| T04-X-commit | A dropped response after the central start commits must resolve to the one recorded conversation on restart. | G04 |
| T04-X-response | A crash after the local response must preserve central idempotency without persisting request content. | G04 |
| T04-X-teardown | An interrupted teardown must release process ownership and recover with the same opaque operation ID. | G04 |
| T04-X-start-commit | A held successful start response must survive a process kill and resolve to one conversation. | G04 |
| T04-X-receive-commit | A held receive response must redeliver the same immutable message after lease expiry and restart. | G04 |
| T04-X-reply-commit | A held reply response must recover the one recorded reply without replaying content. | G04 |
| T04-X-complete-commit | A held completion response must recover the one terminal completion. | G04 |
| T04-X-ack-commit | A held acknowledgement response must recover from the content-free tombstone. | G04 |

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
