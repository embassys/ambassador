# Implementation status

Status: current development snapshot as of 2026-09-01

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
- live registration and Mailosaur email delivery passed;
- live DPoP verification passed;
- token/key binding matched;
- valid protected polling passed;
- missing proof, wrong key, replay, and wrong authorization scheme were
  rejected; and
- current message consumption and acknowledgement semantics traced in source.

## Work remaining

The repository code does not yet implement ADR 0037 end to end. Existing
central fixtures and modules still contain bearer-era and speculative
versioned behavior. The implementation order is:

1. I02 replace tests and fixtures.
2. I03 replace enrollment, credential validation, and DPoP transport.
3. I04 replace protected tools and message handling.
4. I05 run the live two-identity E2E.

`list_action_types` and generated OpenAPI now work live. The catalog returned
six actions; `get_email` and `get_phone_number` each require a string `reason`.
The full permission/action E2E waits only for the gateway reimplementation.

The provider-neutral connector, Codex adapter, and Claude adapter have local
fixture implementations, but their central-facing flow assumed removed
conversation/reply routes. They require a later redesign and have no current
live support claim.

## Published package

`0.2.6` is historical development software and is not supported against the
current DPoP REST contract. New documentation must not direct users to it.
The next package requires explicit publication approval after I05.
