# ADR 0087: Usernames and accepted actions

Status: Accepted (user request, 2026-09-15)

The user asked the CLI and desktop app to adopt the current central API. Review
is pinned to agent2agent `a15ae38f0c9febf94ea354e61d8fe834972c1f55` and the deployed
OpenAPI document retrieved on 2026-09-15.

Agent registration now requires a chosen username as well as email. New handles
contain 5–32 ASCII letters or numbers and are stored lowercase. Lookups accept
existing shorter handles; do not apply signup rules to another agent's name.
Missing usernames become a setup question before any registration mutation.
The owner-first desktop endpoint still takes no username and allocates one on
the server. Keep its one-code flow. Do not invent an unsupported owner field.

Catalog entries include `verified`. Preserve this review status and accept empty
JSON schemas for unreviewed entries without calling them reviewed or inventing
constraints. Continue to validate payloads and results against the catalog and
use its exact action names, with the server's documented case normalization.

Expose GET/PUT `/api/available_actions` through typed message-box operations and
private desktop IPC. The app lets the owner inspect a peer and explicitly save
the complete list their local identity accepts. No automatic declaration on
signup. Null means no restriction has been declared; an empty list accepts no
new permission requests. Neither state grants access, revokes an existing grant,
nor proves that a provider can execute an action. Unknown declared names create
unreviewed catalog entries, so show this effect before saving a custom name.

Before a new outbound request with a target, read its accepted actions and use
the canonical email returned by central in saved dispatch state. Keep the
original request fingerprint for replay checks. Reject an unavailable action
before requesting a new permission. For an action request, an existing grant
for the exact action, grantor and current grantee can still be used. Persist its
ID with ready outbound intent and call central without a new permission request.
Central validates expiry, use limits, scope and revocation at dispatch; never
replace a refused grant automatically. Central remains authoritative if the list changes
between lookup and submission. Repeated checks recover the saved operation;
they do not resolve a username again or dispatch a new request.

Configuration writes are explicit whole-list replacements. Never replay a PUT
automatically after a lost response. Read back on an explicit refresh before
deciding what to submit next. There is no central revision/CAS or reset-to-null
operation, so do not present either as supported.

Central MCP removal needs no client change: the CLI and desktop already use
REST with the existing reviewed Bearer plus DPoP wire profile. Owner APIs remain
separate from agent credentials. Public profiles are server-rendered HTML;
do not scrape them for authenticated identity or infer handles from email.

Update fixture contracts, regression tests, protocol and qualification evidence
with these changes. Central implementation remains issue-only. No dependency,
new CLI flag or release is included.

## Follow-up against the supplied September 15 API document

The follow-up review pins server `d5365b7`; its three commits after `a15ae38`
change database pool budgeting, not endpoint contracts. Add the existing
`verified_only` boolean to the catalog tool as an optional discovery filter.
Default discovery and internal schema validation keep the full catalog. Review
status never grants permission or silently removes custom actions from a saved list.

Expose a read-only `message_box` variant, `get_action_progress`, using the
server's call ID. Validate bounded, ordered events and exact call correlation.
This snapshot neither consumes queued messages nor completes a local operation:
even a central `completed` status is not the requested action result. Continue
receiving and retaining that result through the existing durable workflow.

ACP tool questions use `request_kind: provider_option`. Persist an increasing
generation before each gated tool invocation under a stable installation/provider
key in encrypted local custody. Each new question supersedes earlier generations;
lost-response recovery keeps the exact saved generation and idempotency key.
Scope new installations separately so Clean cannot restart a counter under an old
key. Preserve exact provider options; ordinary owner questions remain text answers,
never resource grants. Provider questions and the local wait expire after 72 hours,
matching the existing email-link lifetime. Cancellation or expiry never approves a
tool. Central has no explicit invocation-end route, so a stopped provider's question
can remain visible until expiry or supersession; local correlation still prevents
its answer from authorizing another invocation.
