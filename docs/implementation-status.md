# Implementation status

Status: Phase 3A release candidate as of 2026-09-02

## Decision

ADR 0037 replaced both earlier central clients with one current target:

- `https://mcp.embassys.ai/api`
- unversioned REST routes
- email-only registration
- P-256 JWK in the verification body
- `Authorization: Bearer` plus a separate DPoP proof
- permissions, action calls, consuming message polling, and acknowledgement
- no central MCP, `/api/v2`, reissue, activation, lease, conversation, reply,
  outcome, legacy support, or migration

## Evidence complete

- central source commit `b769896b7cfb1ee3540195be9e7a61cf777b9388`
  inspected;
- complete route surface classified;
- Node and independent Python fixtures replaced with the current REST and DPoP
  contract;
- enrollment, one-format encrypted credential storage, validation, and
  protected transport replaced;
- seven fixed REST-backed tools and the consuming-poll lifecycle implemented;
- obsolete bearer-only, central MCP, `/api/v2`, migration, reissue,
  activation, lease, conversation, reply, completion, and outcome paths
  deleted;
- the current gateway suite passed 122 tests with two package-lane skips and
  no failures;
- the independent Python fixture passed five tests and the packed gateway
  passed its Docker REST E2E;
- all 69 connector foundation checks, 31 Codex adapter checks, and 30 Claude
  adapter checks matched their reviewed inventories;
- production dependency and signature audits passed; and
- the packed live run passed registration, two Mailosaur deliveries,
  verification, encrypted restart, DPoP positive and negative cases,
  permission decision, action delivery, polling, acknowledgement, and artifact
  scans with no central MCP request.

## Live limitation retained

`list_action_types` returned six actions. The live `get_email` and
`get_phone_number` schemas each require a string `reason` and include the
deployed property description recorded in the fixtures.

The protected `get_my_permissions` call still returns a server error. This
matches the pinned source, which constructs username fields while its response
model declares email fields. The gateway validates the declared email-field
model if the route succeeds and otherwise returns a safe local error.

Central consumes a message when it returns the poll response. If the gateway
stops before acknowledgement, the in-memory body can be lost and cannot be
recovered from the ID-only journal. The release candidate tests and documents
this behavior without adding a lease or local body store.

## Work remaining

The provider-neutral connector, Codex adapter, and Claude adapter have local
fixture implementations, but their central-facing flow assumed removed
conversation/reply routes. They require a later redesign and have no current
live support claim.

## Published package

`0.2.6` is historical development software and is not supported against the
current DPoP REST contract. New documentation must not direct users to it.
Phase 3A does not publish a package; any replacement publication requires
explicit approval.
