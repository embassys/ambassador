# Current server contract adoption, September 15

The user asked the CLI and app to use the new username and accepted-action APIs.
[ADR 0087](adr/0087-usernames-and-accepted-actions.md) records the adopted design.
No server implementation or release is part of this change.

## Follow-up against the shared API document

Rechecked main at
[`d5365b7`](https://github.com/embassys/agent2agent/commit/d5365b7b76f49fa1341f80bed1e764a04f79eeb4)
and retrieved production OpenAPI again. The three intervening commits change
database connection budgeting, not HTTP request/response contracts.

The document is useful but some examples are invalid:

| Supplied example | Reviewed contract |
| --- | --- |
| Submit an action result with `status: completed` | Request status is `success` or `error`; the response uses `completed` or `failed`. The live schema includes this request pattern. |
| Owner decides with `decision: granted` | Send a choice offered for that request: `accept`/`deny` or `allow_once`/`allow_always`. `granted` is the resulting state. This is checked by server decision logic, not the loose OpenAPI string type. |
| Provider human-input example omits its action name and invocation | The runtime model requires `permission_type` or `action_type`, and `request_kind: provider_option` requires `provider`. These cross-field validators are not fully expressed in OpenAPI. |
| Renewal is labelled public in the index | The existing token and DPoP proof authenticate renewal. No client authentication change is needed. |
| Poll timeout has no confirmed bound | Server source caps it with `settings.poll_timeout_max`. The client continues bounded 30-second polls. |

[Issue 23](https://github.com/embassys/agent2agent/issues/23) requests corrected
examples and executable checks. No invalid production mutation was sent to
demonstrate the problems.

Additional client work is implemented:

- `list_action_types` accepts optional `verified_only: true`, signs that query
  in DPoP, and rejects a filtered response containing unreviewed rows. Internal
  schema validation still loads the full catalog. The app has a reviewed-only
  display filter; hidden custom selections remain in the owner's saved list.
- `message_box` accepts `get_action_progress` with a call ID. The read validates
  correlation, ordering, event uniqueness, known states and bounded output. It
  consumes no messages and cannot complete a saved operation without its result.
- ACP approvals declare `provider_option` with an installation/provider key and
  increasing generation saved in encrypted custody before sending. A restart
  cannot reset that generation. Lost-response recovery keeps the same body and
  idempotency key. Exact provider labels/values are unchanged; ordinary owner
  questions are not promoted to grants. Provider questions and local waits have
  a 72-hour expiry, matching existing email-link lifetime.
- A regression reproduced an approval wait surviving provider exit. Provider
  exit and invocation cleanup now cancel that wait. The next invocation cannot
  inherit a late answer.
- Accepted-list restrictions block new permission requests, not standing grants.
  For a restricted action, the client reads current permissions and matches the
  exact action, grantor and current grantee. It saves that grant with ready intent
  before dispatch and sends no new permission request. Central still checks
  scope, expiry, remaining uses and revocation. A denial never becomes an
  automatic request for replacement access.

Central can supersede or expire provider invocations but cannot explicitly end
one when a local process stops. [Issue 24](https://github.com/embassys/agent2agent/issues/24)
tracks prompt removal of those stale owner-inbox items. The local cancellation
and correlation checks do not depend on that future route.

Existing recovery, leased receipt, progress delivery, owner account/history,
device, People and push routes remain integrated. The receiver already repolls
immediately after a nonempty batch; lease metadata never changes message identity.
There is no reason to expose all 61 server operations as agent tools: owner
decisions stay private, emailed token handlers stay on the server, and
`resource_grant` is not a substitute for an ACP provider's exact offered option.
Owner requests retain their separate bearer-session contract; agent calls retain
Bearer plus DPoP. Neither central MCP nor OAuth is reintroduced.

Follow-up validation:

- Shared core: 610 passed, four expected skips (614 total), no failures.
- Desktop: 53 render/artifact checks, typecheck, production build and isolated
  bundled Node/SQLite/ACP/MCP worker check passed.
- Independent Python HTTP fixture: eight tests passed, including reviewed-only
  discovery, stale provider generations and question expiry. The packaged CLI
  completed signup, catalog filtering and accepted-list changes through MCP
  against this fixture.
- Regression checks cover malformed/wrong-call progress, duplicate/out-of-order
  events, read-without-consumption, exact DPoP query binding, lost approval
  responses, durable generations across restart, expiry, cancellation and
  provider exit. The provider-exit test failed before its production fix.
- The standing-grant regression failed before its fix. The final MCP/HTTP test
  exercises a granted action after the peer closes its accepted list, without
  another permission request. Additional checks reject grants for another action
  or either wrong identity and preserve central revocation between read and dispatch.
- Lint and whitespace checks passed. Evidence files use `followup-`, `final-` and `grants-` prefixes
  under `.build/central-review-2026-09-15`.

The live and native UI limits below still apply to these additions. Automated
results are not evidence of deployed protected requests or native display.

## What changed upstream

Reviewed `embassys/agent2agent` main at
[`a15ae38`](https://github.com/embassys/agent2agent/commit/a15ae38f0c9febf94ea354e61d8fe834972c1f55),
including the two username/action commits since the previous reviewed `8c648d8`.
The deployed `/openapi.json` agrees with the new registration and availability
schemas. Source and wire evidence are retained locally under
`.build/central-review-2026-09-15`.

| Server capability | Client adoption |
| --- | --- |
| Agent signup requires email and username | CLI/MCP signup asks for a chosen handle before sending or persisting a registration; private app agent registration carries it too. Invalid or taken usernames do not become an email-recovery deadlock. |
| Username canonicalization | New handles use 5–32 ASCII letters or numbers. Lookups accept stored shorter handles. Email, username and action-name case normalization follows central. |
| Catalog `verified` and custom empty schemas | Catalog reads no longer reject the new field or an empty schema. Review metadata is preserved. Success results still use the published result schema where one exists. |
| `GET /api/available_actions` | Message-box and private desktop reads support self or another agent by email/username. Null and empty lists remain distinct. |
| `PUT /api/available_actions` | Explicit full replacement through the message box or Settings → Accepted requests. Unknown names are identified as unreviewed declarations. No automatic setup declaration or automatic retry of an unconfirmed write. |
| Permission-request rejection outside the target list | Check before sending; store a bounded, durable refusal with an inspection path. Existing exact grants remain callable without requesting new permission. Central validates those grants at dispatch. |
| Address targets by username | Resolve once to central's canonical email before saving an outbound operation. Keep original normalized input for request-ID conflict checks. Restarts and checks do not resolve or send it again. |
| One-code owner signup | Preserved. The owner endpoint assigns a handle but cannot choose or return it yet. |
| Public profile HTML | Server-hosted. The app does not scrape it or guess an owner's handle. Issue 22 is needed to show the actual owner profile identity reliably. |
| Central MCP removed | No transport change. CLI and desktop already use REST; local MCP remains the agent tool channel. The existing DPoP wire profile remains unchanged. |

The remaining owner APIs were compared with the previous reviewed revision.
Owner sign-in, recovery, device selection, requests and decisions, permission
history/revocation, communications, invitations/connections and push integration
remain on the existing implemented routes. Old web-session/email-decision helpers
are not exposed as extra agent approval tools. Permission decisions remain owner
operations.

## Behavior and limits

An accepted action means the owner is willing to receive a permission request.
It is neither a grant nor a claim that the configured provider has that tool.
Removing an accepted action does not revoke an existing permission. The server
has no reset-to-null or conditional-update contract; the UI does not promise one.
The app binds a save to the exact enrolled agent it displayed. A changed identity
requires reopening the view. Unconfirmed writes disable further saves until an
explicit refresh succeeds.

Action schemas remain untrusted and are validated in bounded workers. Catalog
reads have a 5,000-entry and 512 KiB normalized-response bound. A blocked request
stores only a short preview of available names, so a 500-name list cannot exceed
its event-storage quota.

The owner signup endpoint does not accept a chosen username and `OwnedAgent`
responses omit the stored one. This is tracked in
[API issue 22](https://github.com/embassys/agent2agent/issues/22). Guessing from email
would be wrong after allocation collisions and for existing handles.

## Validation

- Updated both central fixtures to require usernames, return catalog review
  metadata and implement accepted-list reads/writes and permission refusal.
- Regression tests cover malformed, missing and case-normalized usernames;
  grandfathered short lookups; reviewed/unreviewed schemas; null versus empty;
  list replacement/deduplication and bounds; a lost PUT response; canonical
  target custody across restart; blocked requests without permission submission;
  and bounded refusal events for a full 500-name list.
- Desktop integration covers setting policy through private IPC, reading it
  through MCP, custom catalog registration, refusing a stale identity, and
  reading the policy after restart. The six local tools remain stable.
- The shared core run passed 596 tests with four expected skips. All 53 existing
  desktop artifact/render tests, desktop typechecking, the production desktop
  build and its isolated bundled worker check passed. The final targeted run
  passed 57 tests covering the subsequent bounded-refusal and registration-display
  checks. A further 16 contract/desktop tests passed after fixture alias handling
  was aligned. The Python fixture passed all seven tests on CI’s `linux/amd64`
  target, and the built CLI completed enrollment, catalog discovery, username
  lookup and accepted-list replacement through MCP against that separate HTTP
  fixture. The final desktop build and bundled-worker check
  also passed.

Live qualification is incomplete. The saved test-mailbox credential returned
HTTP 401 on September 15, so no new live signup, permission email or accepted-list
mutation was attempted. Native app control reported a locked Mac. The browser
security policy also refused the local preview; no alternative route was used
and no UI walkthrough or screenshot is claimed. The updated local qualification
script supplies stable, unique usernames for its disposable accounts.
