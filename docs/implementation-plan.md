# Implementation plan

Status: active plan for the current central REST integration

## Rules

- ADR 0037 is the central contract authority.
- Update tests and fixtures before production gateway behavior.
- Use REST only. Do not add a central MCP client, token argument, route probe,
  fallback, or API-version negotiation.
- Replace old paths. Do not retain bearer-only central support, speculative
  `/api/v2` behavior, credential migration, activation, reissue, leases,
  conversations, replies, outcomes, or compatibility switches.
- Keep the public gateway CLI unchanged.
- Keep message and action content out of SQLite, logs, diagnostics, temporary
  files, crash artifacts, and support bundles.
- Do not add a dependency without separate user approval and an ADR.
- Label fixture evidence as fixture evidence. Label live evidence with the
  source revision and observation date.

## Phase 3A: refresh and switch the live server integration

### I01: pin and accept the current server contract

State: complete in the documentation rebaseline

Work:

- pin `embassys/agent2agent` commit
  `b769896b7cfb1ee3540195be9e7a61cf777b9388`;
- inventory every REST route and classify MCP/OAuth as unused by the gateway;
- verify live registration, email delivery, verification, token binding,
  protected polling, missing-proof rejection, wrong-key rejection, replay
  rejection, and the required authorization scheme;
- record the source and live message semantics; and
- supersede the proposed versioned contract through ADR 0037.

The follow-up commit restored JSON codecs, `list_action_types`, and generated
OpenAPI. The live catalog returned six actions. `get_email` and
`get_phone_number` each require one string `reason`.

### I02: replace central fixtures and tests

State: next

Work:

- replace the Node and independent Python fixture contracts with the current
  unversioned REST routes;
- issue 30-day HS256 test tokens with `sub`, `email`, `iat`, `exp`, and
  `cnf.jkt`;
- require `Authorization: Bearer` plus the separate DPoP proof on protected
  fixture routes;
- cover optional server-provided nonce behavior, wrong key, token hash, exact
  URL, method, age, future time, and replay;
- model current consuming polling and non-idempotent acknowledgement;
- seed the live `get_email` and `get_phone_number` schemas with required string
  property `reason`;
- replace the old enrollment, reissue, activation, lease, conversation, and
  reply inventories with the I02 inventory; and
- change CI expectations before touching production central clients.

Completion evidence:

- the replacement fixture self-tests pass;
- new gateway contract tests fail only because production code still uses the
  removed contracts;
- no test expects central MCP or `/api/v2`; and
- artifact checks find no credential or content.

### I03: simplify enrollment, credentials, and DPoP transport

State: blocked on I02

Work:

- implement `/api/register_agent`, `/api/verify_email`, and
  `/api/resend_verification` with the source-derived shapes;
- remove username from registration;
- put the public JWK in the verification body and remove the issuance proof;
- validate the current token claims and key binding without requiring issuer,
  audiences, token ID, token type, or a 24-hour lifetime;
- send protected tokens with `Authorization: Bearer`;
- keep the separate DPoP proof and optional nonce retry;
- reduce the encrypted credential to one current format; and
- delete old credential readers, replacement, recovery, reissue, central MCP,
  and verbose-transcript code.

Completion evidence: the I02 enrollment, credential, DPoP, corruption,
restart, and artifact tests pass.

### I04: replace protected tools and message lifecycle

State: blocked on I03

Work:

- replace dynamic central MCP tool discovery with fixed local schemas;
- implement the current REST routes for actions, permissions, polling,
  permission listing, and acknowledgement;
- delete activation, conversation, reply, completion, outcome, lease, and MCP
  fallback clients;
- retain bounded in-memory messages and the ID-only relay journal;
- implement current consuming-poll startup cleanup; and
- make restart-loss behavior explicit in errors and tests.

Completion evidence: all replacement integration, local MCP, relay, process,
package, and artifact tests pass with no old path in the built files.

### I05: live development E2E

State: blocked on I04

Use two disposable Mailosaur identities and the deployed REST server. Keep all
addresses, codes, tokens, proofs, messages, and action payloads in memory and
delete captured mail in cleanup.

Prove:

1. register, receive email, verify, restart, and load the encrypted credential;
2. missing proof, wrong key, stale or future proof, wrong URL, wrong token hash,
   and replay fail;
3. a valid protected poll succeeds with `Authorization: Bearer` plus `DPoP`;
4. `list_action_types` returns `get_email` and `get_phone_number` with the
   pinned `reason` schemas;
5. one identity requests permission from the other;
6. the target polls, grants or denies through `respond_to_permission`, and
   acknowledges the permission message;
7. a granted action is delivered, polled, and acknowledged;
8. the packed gateway sends no central MCP traffic; and
9. artifact scans contain no credential, email, code, action payload, or
   message body.

The E2E records the consuming-poll restart limitation instead of pretending
to prove redelivery.

## Follow-on provider work

Provider connectors do not block I02 through I05. After the gateway's live
permission/action flow works:

1. decide which central message types should invoke a provider;
2. replace the connector's conversation/reply assumptions with that actual
   workflow;
3. update connector tests before implementation;
4. rerun Codex and Claude fake and manual qualification; and
5. seek separate publication approval.

The existing provider process security decisions remain unless this rework
shows a direct conflict. Gemini still has no approved interface.

## Release gates

| Gate | Required evidence |
| --- | --- |
| A | I02 replacement tests and fixtures reviewed |
| B | I03 and I04 code passes local, Docker, package, and artifact suites |
| C | I05 passes against the pinned live REST service and fixed action catalog |
| D | Documentation, package contents, dependency audit, and supported platforms match the implementation |
| E | User explicitly approves publication |

No old package or old fixture result can substitute for these gates.

## Current blockers

- Existing central tests and production modules still implement the removed
  contracts and must be replaced in the order above.
- `get_my_permissions` still needs a protected live check because the source
  constructs fields that differ from its response model.
