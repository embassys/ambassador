# Central contract adoption, September 14

The server work closed in issues 1–13 is now integrated in this candidate under
[ADR 0082](adr/0082-current-central-recovery-and-owner-integration.md). Server
source was reviewed at `58e554b48bb8c5e6e8bd399f298087da6d0e236b` and kept read-only.
This work is on `codex/people-discovery`, alongside the unreleased People and
Linux ARM64 changes. No package version, public CLI argument or dependency changed.
Nothing from this candidate has been merged, published or released.

## Retest after issue 15 was repaired

The subsequent server review includes `2e96e4bafa2a9fc9603e57c493e87d3939312bc9`.
Issue 15 was a production timestamp-column mismatch, fixed by migration 015 and
a service restart. Fresh protected reads now pass, and reusing a DPoP proof still
returns 401. No authentication fallback was needed.

The live action test found a missed client contract change: `/api/call_action`
returns `status: "queued"`, while Ambassador still expected `"delivered"`.
The client, independent Node/Python fixtures and packaged qualification runner now
use `queued`. A failing regression preceded the fix. A queued receipt proves
central acceptance only. The fixture catalog now includes the nine observed
actions and their declared result schemas, including nullable phone/email schemas.

The related fixes in issues 16, 17, 19 and 20 are adopted:

- `GET /api/owner/agents` refreshes the signed-in account's authoritative roster
  without another code. Registration, profile refresh and Devices & agents use it.
  Refresh persists the roster without changing the account context or event cursor.
  Invalid, duplicate or unavailable rosters cannot replace the last confirmed list.
- Device confirmations re-read agent ownership, verification and executor epoch.
  A transfer away and back invalidates an earlier review even if the device ID
  is unchanged. A new list never selects an executor automatically.
- Calendar catalog descriptions agree with exact-action permission checks.
  Invitation and connection timestamps again require an explicit timezone offset.
  Execution-token responses carry `Cache-Control: no-store` on the live service.

Controlled live tests using the actual client classes and disposable accounts passed:
permission approval in the owner API, dropped-response recovery after reopening
encrypted journals for permission/action/question/result submissions, 120-second
lease expiry and identical redelivery, explicit release, repeated acknowledgements,
duplicate progress suppression, text owner input, exact synthetic phone results,
same-key renewal with encrypted restart, and execution-device transfer fencing.
The old execution token could no longer poll; the new device could.

Separate live calendar tests passed rejection of a permission-only grant for a
data action, client and server rejection of a decision-only success, and receipt
of exact synthetic busy intervals. Invitation creation/acceptance timestamps and
execution-token cache headers passed. No real calendar, contact or provider chat
was used. These are deployed API tests, not evidence of native chat display.

Reports are `live-protected-after-15-report.json` and
`live-calendar-after-15-report.json` under the evidence directory below. Temporary
encrypted account stores and captured test mail were removed. An initial run hit
an HTTP 502 during email verification; later fresh runs completed. That response
was distinct from the repaired replay-protection 503.

The clean-installed package also passed the existing live qualification runner
against deployed central with a deterministic mock ACP target. It covered local
MCP enrollment, encrypted restart, the negative DPoP matrix, emailed permission
and provider-tool approval, saved outbound intent, the complete action/result
round trip, custody before acknowledgement, log redaction and cleanup. This does
not claim a real model or native UI test. Package SHA-256:
`2f79f2446487c87847cd793be88da914d6b513e8555574984bcfc9ebd0d979d2`.
The unmodified run report is `packaged-live-after-15.log`; its two historical
limitation strings predate the lease/idempotency changes. This record supersedes
those strings, and the runner's report text has been corrected for future runs.

Final checks: **588 repository tests passed, seven expected skips**, all **45
desktop checks**, typechecks, lint, production build, the bundled real MCP worker
probe and **six independent Python fixture tests**. The Python fixture runs on
its locked Linux x64 target. The first native ARM64 Docker attempt correctly
refused wheels outside that lock; no package hashes or versions were changed.

## What works in the client

| Area | Implemented behavior |
| --- | --- |
| Submission recovery | Exact request bodies and original operation keys enter encrypted custody before submission. Recover saved receipts or reuse the same key/body within 23 hours. Old unkeyed work and expired attempts remain uncertain. |
| Message custody | Leased redelivery deduplicates without replaying provider prompts. Uncertain acknowledgements retry with bounded backoff. Failed batch custody releases messages without claiming receipt. |
| Credentials | Same-key renewal atomically replaces an encrypted credential. Email verification retains its pre-request key across restart. Explicit legacy recovery preserves the central agent ID and existing key; lost recovery responses require a fresh code. |
| Owner account | Separate device-bound owner sign-in and refresh use the current owner realm. The app retains local contacts when requiring a fresh sign-in from the older app realm. Codes, tokens and private keys stay out of public IPC and logs. |
| Devices | Review the named device before selecting an executor or revoking access. Stop the selected app server and acquire its installation lock before a local transfer. Private IPC installs the issued execution credential; an encrypted archive key preserves local conversations. Unconfirmed transfers are not replayed. |
| Requests and history | Paginated inbox, grants and permission history; exact option values and revisions for decisions/answers/revocation; recovery of uncertain keyed submissions. Owner events have an independent durable cursor and paginated recovery after cursor expiry. |
| People | Local contacts, explicit invitations, incoming accept/decline and connected people. Contact import never invites automatically, and accepting an invitation creates no action grant. |
| Action results | Non-null catalog result schemas validate successful output. Correlated progress wakes observers without completing the action. Owner questions send a generic waiting status. Ten-minute waits and explicit continuations remain. |
| Notifications | Private macOS APNs registration, server readiness status and fetch-on-wake. Running-app notifications remain available without remote push. A server acknowledgement is not claimed as desktop delivery. |

Calendar guidance now distinguishes `get_free_busy` data from
`get_free_busy_permission` decisions. There is no permission-name translation.
Pending owner requests may supply conversation labels only when the local and
remote central IDs match. If no authoritative identity is available, the app
shows the remote ID rather than guessing from conversation text or local contacts.

## Validation

- Repository suite before the follow-up: **584 passed, seven expected skips**. Added coverage includes
  response loss, restart, expired retention, credential-write failure, preserved
  ciphertext after a key change, device review changes, fencing claims, invalid
  success schemas, duplicate/out-of-order progress, cursor expiry and notification
  custody failure. Explicit recovery requires a new code after an uncertain result.
- Desktop: **45 artifact/render checks passed**. Root and desktop typechecks,
  formatting/lint and production build passed. The bundled Node 24, SQLite, ACP
  dependency and real MCP worker check passed with an isolated PATH.
- Live API: disposable email accounts passed agent registration and verification,
  owner sign-in on two devices, profile/inbox/grant/history/event reads, invitation
  email delivery, duplicate invitation reuse, acceptance and connection listing.
  Accepting an invitation did not create a permission grant.
- Live devices: selection issued a correctly bound execution token; transfer
  increased the epoch, and the old device could no longer issue that token.
  Remote revocation invalidated its owner session. Legacy email recovery retained
  the existing agent ID and key. These are API assertions, not provider execution.
- Native Mac: used the real renderer in an isolated offline sample-data host to
  inspect Saved/Connected/Invitations, accept a sample invitation, review device
  transfer and cancel it. Fixed the device dialog's default browser border/padding
  and verified Escape restores focus to its initiating button. The gallery uses
  fictional populated requests/conversations, not real contacts or live-provider
  results. Evidence is in `.build/central-review-2026-09-14/screenshots/`.

Logs and content-free reports are in `.build/central-review-2026-09-14/`, including
`final-root-tests.log`, `desktop-artifacts.log`, `desktop-verify.log`,
`live-owner-report.json`, `live-devices-recovery-report.json` and
`invitation-mail-report.json`. The latter confirms receipt in the disposable
recipient’s mailbox, not just the server’s delivery flag. Test mailbox
messages and local temporary account stores were removed. Disposable server test
identities remain; no general owner-account deletion route is available.

## Still blocked or unqualified

**Provider qualification:** issue 15 no longer blocks protected API calls. The
recovery and synthetic action flows above pass against deployed central. The
earlier provider/platform matrix still applies; these API checks do not qualify
every agent's native display or calendar integration.

**Remote push:** the live owner status explicitly reports “This server has no push
credentials configured.” macOS also needs signed app identity and actual-device
qualification. Windows needs an approved native WNS bridge; the current approved
Electron runtime exposes no equivalent Windows push registration API. Linux keeps
running-app notifications and email. No claim of delivery while the app is quit.

Issue 21 subsequently shipped owner-authenticated first-agent creation.
One-code desktop setup is implemented under ADR 0083; native and deployed
qualification are recorded in [the onboarding record](one-code-onboarding-2026-09-14.md).
The owner roster refreshes without another sign-in under issue 17.
Issue 18 has also shipped general communication history. Client adoption and
queue-isolation qualification are still pending. Permission history is not
complete provider chat history.

Calendar wording, invitation timestamps and execution-token cache headers are
fixed in issues 16, 19 and 20 and passed the follow-up checks above.
The separate DPoP contract decision remains
[14](https://github.com/embassys/agent2agent/issues/14).

Review/merge, release approval, release CI, signed distribution and the previously
recorded platform/provider qualification remain in the
[work plan](implementation-plan.md). This candidate is not a production release.
