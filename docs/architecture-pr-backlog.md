# Architecture PR backlog

Status: Phase 3A complete; R01 and C01 remain

The immediate goal is a small gateway that works with the current Embassys
REST server. Each PR is independently reviewable. Tests change before the
production path they specify.

## Dependency graph

```text
D00 documentation rebaseline
  -> I02 fixture and red-test replacement
      -> I03 enrollment, credential, and DPoP switch
          -> I04 protected REST tools and message switch
              -> I05 live two-identity E2E
                  -> R01 development release review

I05 -> C01 provider connector flow redesign -> provider requalification
```

## D00: documentation rebaseline

State: complete

Scope:

- add ADR 0037;
- pin the server source and record live evidence;
- replace the versioned architecture with the current unversioned REST API;
- classify central MCP as unused;
- remove compatibility and migration requirements from active plans; and
- mark affected ADRs and test inventories superseded.

Completion evidence: all current documents agree on route names,
authorization headers, DPoP claims, token lifetime, message behavior, and the
absence of old-client support.

## I02: fixture and test replacement

State: complete on 2026-09-02

Primary ownership:

- `test/support/fake-central.ts`
- `test/fixtures/central/`
- central contract and process harness tests
- test inventories and CI classification scripts

Required changes:

- replace both old central contracts with the source-derived REST contract;
- keep fixture cryptography independent;
- add current DPoP positive and negative vectors;
- model email-only registration and body JWK verification;
- model permission/action messages and consuming poll;
- delete reissue, activation, lease, conversation, and reply expectations; and
- create a reviewed red inventory for absent production behavior.

Do not change `src/` in this PR except a test seam that has no production
behavior and is necessary to run the new fixture.

## I03: enrollment, credential, and DPoP switch

State: complete on 2026-09-02

Primary ownership:

- `src/central-enrollment.ts`
- `src/dpop.ts`
- central protected transport
- credential parser and store
- gateway identity startup

Required changes:

- implement the three current enrollment routes;
- remove username and issuance-proof requirements;
- accept the current 30-day token claims and validate key binding;
- change protected authorization to `Bearer`;
- retain fresh proofs and optional nonce retry;
- define one current encrypted record; and
- delete old credential, reissue, recovery, MCP, and transcript code.

The PR passes the I02 enrollment and security tests before merge.

## I04: protected tools and message switch

State: complete on 2026-09-02

Primary ownership:

- gateway application and local tool catalog
- protected REST clients
- notification relay and journal integration
- package and artifact tests

Required changes:

- use fixed local tool schemas backed by REST;
- implement action discovery, permissions, action calls, poll, permission
  listing, and acknowledgement;
- remove central MCP discovery and all proposed versioned message clients;
- preserve bounded in-memory custody and ID-only persistence;
- clear stale IDs after restart; and
- prove the built artifact contains no obsolete central path.

I03 and I04 should be serialized because they overlap in application startup,
identity, tool exposure, errors, and test support.

## I05: live E2E and package evidence

State: complete on 2026-09-02

Use two disposable Mailosaur addresses. Run the packed gateway against the
live origin and prove:

- registration, email delivery, verification, persistence, and restart;
- DPoP positive and negative cases;
- the fixed email and phone action schemas;
- permission request and decision;
- action delivery, poll, local retrieval, and acknowledgement;
- no central MCP request; and
- no content or credential in artifacts.

The live report must state that consuming polling can lose a message on
gateway crash. It does not claim lease recovery.

## R01: development release review

State: next; publication is not approved by this work

Review source pin, live behavior, package contents, dependency audit, Linux and
macOS evidence, docs, and the current server limitations. Publication requires
separate user approval. No old package is kept as a supported fallback.

## C01: provider connector redesign

State: ready for separate planning after Phase 3A

Start only after I05. Decide how actual permission and action messages map to
provider work and central completion. Update ADR 0030 and connector tests
before production changes.

Keep provider process isolation, local maximum policy, content-free durable
state, uncertain-outcome handling, and credential separation unless a new ADR
changes them.

## Safe parallel work

Provider manual qualification documentation and central server fixes may
proceed while I02 through I04 are serialized. Do not parallel-edit shared
gateway application, identity, credential, fixture, or tool-contract files.

The central owner may fix permission listing and add build metadata
independently. The gateway must update its source pin if those changes alter
the client contract.

## Definition of complete

- One current REST client remains.
- No old credential or migration code remains.
- No central MCP request can occur.
- No `/api/v2` route remains in runtime code or current tests.
- Protected requests use Bearer plus a separate proof.
- Live permission/action E2E passes.
- The consuming-poll limitation is documented.
- Artifacts contain no credential or content.
- Publication has explicit approval.
