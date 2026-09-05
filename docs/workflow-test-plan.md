# Workflow regression and live test plan

Status: deterministic and packaged checks pass; real-client qualification in progress

Every discovered failure gets a regression at the boundary that caused it.
Tests run before implementation. Mock tests exercise failure timing without
real email or provider side effects; controlled live runs prove actual behavior.

| Boundary | Required cases |
| --- | --- |
| Receiving | Later result unblocks an ACP MCP wait; approvals share one poller; provider unavailable; slow execution; shutdown; transient polling failure; empty batches; invalid and conflicting duplicate messages; bounded storage admission |
| Durable custody | Restart before processing, during capture, after capture before ack, after external dispatch; permission and text answer recovery; replay only prepared local work; conflicting duplicate IDs; quota, malformed ciphertext and wrong enrollment; uncertain acknowledgement |
| Submission | Same ID/same body, same ID/different body, concurrent repeats, repeated checks, separate same-payload calls, response loss, permission denial/expiry/exhaustion, matching grant, wrong grantor/action/permission ID, out-of-order events |
| Waiting | Full default 600 seconds; short explicit budget; event just before/after subscribe; event at timeout; disconnect, cancellation and shutdown; wait capacity separate from ordinary tools; no timers/listeners left behind |
| Results | Exact returned data, no model-mediated withholding, unread across restarts and failed reads, explicit receipt, repeated receipt, invalid cursor, pagination, delivery uncertainty, late and duplicate results |
| Owner input | Missing calendar data/phone number creates structured question; exact pending call and message correlation; text/buttons, invalid/oversize menu, empty answer, refusal, timeout, wrong owner/ID, answer before request response, restart, stale answer, no guessed completion |
| Provider approval | Exact labels/IDs/order, no kind mapping or automatic approval, concurrent wait with unrelated messages, cancellation, provider death, stale reply, API bounds |
| MCP | Strict schemas, bootstrap gating, ordinary errors, SSE bytes before final response, backpressure, size limits, idle connection, cancellation, protocol/capability handling, hostile metadata, Host/Origin and credential rejection |
| Native delivery | Trusted origin binding, two simultaneous conversations, changed/deleted route, provider offline, retry and duplicate presentation, accepted versus displayed, active Hermes turn, no arbitrary destination or command |
| Contract | Exact catalog names, broad permission mismatch, names ending in permission, nested/conditional schemas, no coercion/defaults, unsupported dialect, server validation errors, grant direction/current identity, scope/uses limitations |
| Meeting coordination | Enrolled caller with no grants; explicit attendee identity versus desktop-account identity; correct calendar owner and tool binding; availability before booking; shared-slot intersection, duration and timezone/DST; busy slot rejection and alternative; separate read/write grants; owner denial; exact event and invitation evidence; no booking claims from permission alone |
| Logs and CLI | Bodies without verbose, credential redaction, IDs/timing and closures, rotation, oversized records, queue overflow, unwritable/disk failure, clean preservation, confirmed instance stop/default No/noninteractive refusal |

## Executed regressions

The full local check currently passes 340 tests with seven expected platform or
opt-in skips. Both clean-installed Node and Docker REST lanes pass separately.
The Docker fixture's six Python tests pass on its locked linux/amd64 platform.
A separate real SDK/Streamable HTTP call waited 600.011 seconds before returning
pending, then continued the same operation without resubmission. Central was a
controlled fixture for that timed check.

The same runtime candidate passed deployed REST action/result/receipt flows
with real Claude, Codex, Hermes and OpenClaw ACP targets. The Claude desktop
Code UI also displayed and acknowledged exact synthetic data against a
controlled central. Native return and full desktop timeouts have separate
qualification limits recorded in [qualification](qualification.md).

The new regressions cover the supplied stalls and failures found during testing:

- `notification-relay.test.ts` and `notification-store.test.ts` cover independent
  receiving, provider failure, approval routing, custody, duplicates and bounded
  recovery.
- `message-box.test.ts` covers interrupted bindings, prepared dispatch recovery,
  cancellation, durable receipts and completed replies left in the pending inbox
  by interruption.
- `owner-questions.test.ts` and `ambassador-e2e.test.ts` cover exact owner/call
  correlation, answer-before-response, duplicate owner replies and continuation.
  The real desktop follow-up adds foreground-answer scheduling, interrupted
  handoff recovery, stale retries after a later question, completed calls and
  provider approval against the original central notification. Local custody
  tests prove these continuations never receive central acknowledgements and
  uncertain dispatch is not replayed.
- `action-catalog.test.ts` covers exact action names and server schema semantics.
  The meeting qualification exposed a fixture mismatch: known action names were
  duplicated when asking the owner a question. `central-rest.test.ts` now checks
  that repeated owner questions preserve the full catalog for phone, calendar
  booking and free-busy actions, matching the reviewed central implementation.
- `local-mcp.test.ts` covers streaming, protocol handling and separate wait
  capacity. `long-wait-qualification.test.ts` is the explicit ten-minute lane.
- `ambassador-e2e.test.ts` covers unenrolled versus verified identities with
  zero grants, public enrollment metadata, restart and expired credentials.
  `delivery-prompt.test.ts` checks compact type-specific instructions, complete
  untrusted payloads, formatted JSON round trips, embedded newline/code-fence
  strings and safe handling of unknown or malformed message types.
- `direct-delivery.test.ts`, `delivery-profile.test.ts` and
  `verbose-log.test.ts` cover cancellation during ACP startup, the atomic profile
  link window, and JWK redaction found during live artifact scanning.
  Direct delivery also tests requester conversation reuse across a store restart,
  owner replies and later actions, while keeping other requesters and fresh
  enrollments separate. A real OpenClaw restart check confirms this path and the
  directory-free formatted prompt in gateway history and the Mac app.
- Native bridge, OpenClaw hook and Claude channel tests cover trusted routes,
  concurrent observers, uncertain injection, acknowledgement semantics, separate
  OpenClaw service/tool activation and reconnection after a server restart.
- `webhook-delivery.test.ts` covers persistent OpenClaw requester keys across
  target recreation, separate enrollment/provider/receiver scopes, untrusted
  body routing fields and invalid scope or sender rejection before dispatch.
  Real hooks confirm the same provider history for the first requester and a
  different history for another requester.

The requirements table includes release targets as well as automated coverage.
It does not claim every provider/UI case has passed. Windows access-control
checks require Windows; native conversation return and client timeouts require
the specific real clients. See [qualification](qualification.md) for evidence.

## Live acceptance

Use controlled disposable identities and the deployed REST contract. Run real
provider round trips, owner email input, permission options, and delayed result
delivery. Exercise actual ten-minute waits for qualified clients and retrieve
late results after timeout. Verify presentation in the initiating conversation,
including two concurrent conversations, rather than relying on a tool log.

Include fresh conversations with ordinary requests such as "Can you get the
phone number of <email> from his agent?" Supply no tool names, UUIDs, wait or
receipt instructions in the user prompt. Test an enrolled caller with zero
grants and a missing required reason. Capture the first response before answering
questions; distinguish necessary missing input from redundant enrollment checks.
Record the model's chosen wait budgets, reuse of the original request ID,
duplicate submissions and final presentation/receipt. Keep these model behavior
observations separate from deterministic gateway coverage.

For real-provider calendar tests, verify the provider can see and use the
intended test calendar before submitting write work. A configured MCP entry is
not proof of tool visibility or selection. The target must not fall through to
an unrelated native or cloud calendar. Record aborted test connections as
deliberate shutdowns. Preserve failed runs and ordinary human corrections;
do not present a coached recovery as an unassisted short-prompt pass.

Record artifact digest, versions, OS, transport, timeout configuration, observed
capabilities, steps and outcomes. Native bridge and desktop claims remain
unqualified until their exact user-facing path passes. Central failure modes
that cannot safely be induced live remain deterministic regression cases plus
explicit API limitations. Do not publish while release blockers remain.
