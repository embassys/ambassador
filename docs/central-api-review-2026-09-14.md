# Central API review, September 14

This is the initial review. The later issue 15 repair and successful retests,
including the completed fixes in issues 16, 17, 19 and 20, are recorded in
[the adoption record](central-adoption-2026-09-14.md#retest-after-issue-15-was-repaired).
Its findings supersede the original blockers below.

Issues 1–13 in `embassys/agent2agent` are closed as completed. Their implementation
is present in reviewed main
[`58e554b48bb8c5e6e8bd399f298087da6d0e236b`](https://github.com/embassys/agent2agent/commit/58e554b48bb8c5e6e8bd399f298087da6d0e236b),
and the deployed [OpenAPI](https://mcp.embassys.ai/openapi.json) exposes the new
routes. That unblocks substantial client work, but does not mean the features
are integrated or qualified in Ambassador.

The live check found a deployment blocker: newly verified agents receive HTTP
503, `Replay protection is temporarily unavailable`, from protected reads.
[Issue 15](https://github.com/embassys/agent2agent/issues/15) records the reproduction.
No server code was changed. No Ambassador release was made.

## Initial review — implementation now recorded separately

The owner subsequently approved implementation. See the
[adoption and qualification record](central-adoption-2026-09-14.md) for completed
client changes. The table below records the gaps at the start of this review.

## What changed

| Closed issue | Reviewed server implementation | Ambassador work remaining |
| --- | --- | --- |
| [1: message recovery](https://github.com/embassys/agent2agent/issues/1) | Bounded leased batches, stable IDs, redelivery, idempotent batch acknowledgement and explicit release. Default lease is 120 seconds; batch limits are 128 messages and 384 KiB. | New response fields are handled in this candidate. Qualify lost-poll recovery, make uncertain acknowledgements retryable, and integrate release/backpressure without replaying provider work. |
| [2: credentials](https://github.com/embassys/agent2agent/issues/2) | Same-key renewal with an overlap window; email recovery rebinds the existing agent ID to a new key. | Renew and save credentials atomically; add explicit recovery and restart tests. Keep the existing key on renewal because local encrypted stores depend on it. Recovery cannot restore erased local data. |
| [3: stalled polling](https://github.com/embassys/agent2agent/issues/3) | Shared listener connections, bounded listener setup and waiter cleanup. | No new user flow is required. Rerun live delayed-delivery, disconnect and load checks; the local HTTP deadline remains necessary. |
| [4: lost mutation responses](https://github.com/embassys/agent2agent/issues/4) | `Idempotency-Key` and `/api/idempotency_status`, with transactional submission records and a finite retention period. | Persist a central key before each supported mutation, reconcile uncertain outcomes and cover crashes before/after local persistence. Existing submissions without keys cannot be retroactively recovered this way. |
| [5: progress](https://github.com/embassys/agent2agent/issues/5) | Report/read action progress and correlated `action_progress` messages. | Connect progress to saved operations and owner questions. Deduplicate by call/event/sequence. Progress is advisory: even `failed` progress does not complete an action. |
| [6: results](https://github.com/embassys/agent2agent/issues/6) | Nullable catalog `result_schema`, server validation of successful results and explicit calendar decision/data schemas. | This candidate exposes the schema in the catalog. Add local result validation and inbox guidance, and update calendar fixtures/live tests. Null means no declared output contract, not a verified answer. |
| [7: owner/devices](https://github.com/embassys/agent2agent/issues/7) | Owner sessions, registered devices, existing-agent adoption, executor selection and fenced execution tokens. | Integrate the new owner session realm and controlled executor handoff. Never reuse the old app token as a new owner token. |
| [8: owner inbox](https://github.com/embassys/agent2agent/issues/8) | Paginated requests, exact decisions/answers, idempotent owner mutations and a resumable event feed. | Replace bounded snapshot reads and uncertain decision handling with these contracts. Keep owner observation independent of execution polling. |
| [9: permission history](https://github.com/embassys/agent2agent/issues/9) | Paginated grants/history and revocation serialized against permission use. | Add paging, decision history and authoritative refresh after changes. These are account records, not complete provider chat transcripts. |
| [10: native push](https://github.com/embassys/agent2agent/issues/10) | Device registration/preferences and transactional dispatch through APNs/WNS adapters. | Implement platform registration and fetch current state on notification. Real APNs/WNS dispatch was not qualified by the server work; credentials, platform identity and actual device tests remain necessary. Linux retains running-app notifications. |
| [11: invitations](https://github.com/embassys/agent2agent/issues/11) | Owner-authenticated send/list/accept/decline invitations and connections, with duplicate-send handling. | Add Invite, incoming invitations and connection status to People after the owner-session integration. Imported contacts stay local until the user chooses whom to invite. A connection never grants access to an action. |
| [12: verification](https://github.com/embassys/agent2agent/issues/12) | Expiring hashed challenges, bounded attempts, same-key verification replay and required P-256 binding. | This candidate handles the verification replay indicator. Full lost-response recovery needs durable pre-request key custody; generating another key and retrying is insufficient. |
| [13: proof validation](https://github.com/embassys/agent2agent/issues/13) | Replay cleanup, bounded proof fields, duplicate-header rejection, key checks and sanitized agent JWT errors. | Keep the current wire format. Resolve the live replay-store failure in issue 15 before qualifying protected calls. |

These additions are on `/api/owner/*` for owner work. The shipped app uses
`/api/app/*`, with token audience `embassys-app`; the new owner tokens use
audience `owner`. This is an account-worker integration, not a URL substitution.
The new owner token identifies a registered device, but current owner requests
still use bearer authentication. Do not claim that owner requests themselves
require proof of possession; agent execution tokens do require DPoP.

## Remaining contract gaps

- [Issue 14](https://github.com/embassys/agent2agent/issues/14) is still open.
  The server has corrected its RFC 9449 claim, not changed its wire protocol.
  Keep Bearer plus DPoP, current URI handling and current nonce behavior until
  a coordinated contract change is accepted.
- One-code **brand-new** signup remains incomplete. Owner verification adopts
  existing agents but does not create one or mark an unverified agent verified.
  An owner with no agent receives an empty agent list. Returning-owner setup can
  use the new executor-token route after one owner verification; a supported
  first-agent creation/verification step is still needed for the new-user flow.
  The earlier requirement remains recorded in
  [issue 7's onboarding comment](https://github.com/embassys/agent2agent/issues/7#issuecomment-5581439259).
  Do not bypass registration by treating an unverified agent as fully enrolled.
- The calendar catalog still tells agents that `read_calendar_permission`
  authorizes `read_calendar_event_by_title`, while `call_action` checks the
  requested action's exact ID. A decision-only action result also does not
  itself create a permission row. [Issue 16](https://github.com/embassys/agent2agent/issues/16)
  asks for consistent descriptions and a regression. No client name mapping
  was added. Availability now has a distinct `get_free_busy` data action;
  `get_free_busy_permission` is described as returning only a decision.
- Native push infrastructure does not establish delivery while the app is quit
  on every OS. Signed platform identity, delivery credentials and actual-device
  qualification remain separate from API availability.
- The deployed health response still provides no build revision. Standard
  plus-tagged email addresses also remain excluded by reviewed model patterns.
  Not every earlier operational follow-up was covered by closing issues 1–13.

## Compatibility changes in this candidate

Four regressions failed against the previous response handling before the fix:
catalog `result_schema`, poll envelope/message lease metadata, acknowledgement
receipt lists and verification `replayed`. The updated parsers accept and
validate those reviewed fields while continuing to reject unknown fields and
malformed values. Catalog result schemas remain available to callers.

Lease/attempt metadata is removed before computing a durable message's identity.
A later lease for the same message must not appear to be a conflicting payload,
and it must not authorize another provider dispatch. Single-message receipts
must acknowledge exactly the requested ID, contain no unknown IDs, and may say
that ID was already acknowledged. Anonymous/system messages still cannot be
routed as a peer conversation by inventing a sender identity.

The receiver already polls again immediately after a nonempty batch; processing
and acknowledgement remain independent of provider work. This compatibility
change does not yet introduce automatic retries for uncertain mutations or
credential replacement, and does not switch the desktop owner API.

## Validation

- Five added contract tests cover the four failures, changed lease metadata on
  redelivery, conflicting bodies, malformed fields, receipt membership and
  private verification output. The shared central fixture emits the new wire
  fields and models repeated acknowledgements.
- Repository suite: 548 passed, seven expected environment skips, zero failures.
  TypeScript build passed. This is local validation, not a release CI result.
- Three disposable identities registered and verified against deployed central
  over two live attempts around 09:00–09:03 UTC on September 14. The verification
  response included `replayed` and passed the updated credential checks.
- Protected live qualification stopped at the server's replay-protection 503.
  A fresh identity's catalog read failed three times with new proofs, then
  permission listing and an empty-inbox poll failed identically. No permission
  or action was submitted, and no real user's inbox or calendar was read.
  Test email messages were removed; no credentials were written to artifacts.
- Local evidence is in `.build/central-review-2026-09-14/`, including the source
  checkout, live OpenAPI, sanitized observations and test output. The reviewed
  source revision is not asserted to be the deployed build hash.

## Recommended implementation order

1. Resolve issue 15 and rerun protected catalog, populated poll, repeated ack
   and synthetic action/result tests before releasing the compatibility fix.
2. Integrate durable idempotency, safe acknowledgement recovery and same-key
   renewal. Test lost responses and process exits around every commit boundary.
3. Integrate the new owner account/device session in the private worker, with
   account isolation, refresh recovery, revocation and controlled executor
   handoff. Prove that a transferred executor stops consuming work, including
   transfer away and back to the same device.
4. Build People invitations/connections, richer owner request context, paginated
   permission history and resumable updates on that owner foundation. Test
   email/app races, duplicate invitations, stale decisions and sign-out.
5. Add typed progress and output validation, then requalify natural calendar
   requests with the current catalog. Test out-of-order/duplicate progress and
   ensure approvals are never reported as calendar data.
6. Add native push once the corresponding platform credentials and identity are
   available. A notification is a hint to fetch authoritative saved state, not
   proof of approval or successful action execution.

The owner-authentication change needs a recorded amendment to ADRs 0068/0075
before implementation. Server code stays issue-only; publication remains a
separate approval and qualification step.
