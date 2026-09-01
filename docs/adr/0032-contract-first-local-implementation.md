# 0032 Contract-first local implementation before central deployment

Status: superseded by ADR 0037

Date: 2026-08-30

The project now has a pinned public central source and live behavior. Tests
must follow that source-derived contract rather than the former speculative
fixture contract.

## Problem

The accepted gateway and connector contracts are complete, and the repository
has independent version 2 fixtures plus reviewed red suites. Another team will
implement the central service. Waiting for that deployment would prevent this
repository from implementing and testing its client behavior even though the
client-visible schemas, security rules, failure behavior, and fake profile are
already fixed.

The old plan used Gate A and central S02 through S05 as prerequisites for local
gateway code. That combined two different claims:

- whether this repository implements the accepted client contract; and
- whether the real central service safely implements and deploys its side.

Local fixture evidence can support the first claim. It cannot support the
second.

## Decision

Implement G01 through G04, K01 through K04, and the later provider adapters
against the accepted ADRs and `docs/v2-fixture-profile.md` without waiting for
S01 through S07. Keep the existing test-first order and serialize G01 through
G04. The independent Node and Python central fixtures remain test doubles, not
production constants or deployment evidence.

This decision changes implementation prerequisites only. It does not change a
REST route, MCP tool, DPoP rule, message lifecycle, connector boundary, CLI,
state schema, limit, dependency, or provider policy accepted by ADRs 0023
through 0031.

The gateway must keep target version 2 behavior behind the existing
development endpoint boundary until central staging passes. It must not ship a
production default URL, silently fall back from DPoP to bearer authentication,
or describe fixture success as central interoperability.

## Work and evidence labels

Local work may now use these labels:

- `contract-conformant`: the implementation passes the accepted local red and
  fixture suites;
- `fake-E2E`: the full local gateway and connector chain passes against an
  independent test central service; and
- `provider-qualified`: one explicitly approved provider version passes its
  local real-runtime checks.

Local work may not use `central-compatible`, `staging-qualified`,
`production-ready`, or `release-qualified` until S01 through S07 and E01
through E03 supply the required external and combined evidence.

## Central handoff

`docs/central-interface-change-requests.md` is the implementation handoff for
the other team. It must state every unknown production fact, distinguish the
current version 1 API from target version 2, and give black-box acceptance
tests for S01 through S07. A difference in a client-visible schema, security
rule, error, limit, or transaction returns the affected accepted ADR for user
review. A deployment-only value does not amend the client contract.

## Gates that remain

- Gate A still requires the central S01 failure inventory and owner review.
- S07 still gates real central compatibility and production activation.
- E01 through E03 still gate gateway release evidence. ADR 0033 closes W01 as
  deferred, not passed, and removes it from the initial-release gate.
- Each provider still needs its exact interface, version, dependency, license,
  sandbox, approval, recovery, history, update, and platform ADR.
- Q03 and Q05 still require explicit user approval before preview or stable
  publication.

No local implementation commit may weaken a test because the real service is
not ready. Tests use the accepted contract. The central implementation must
catch up or return a material difference for review.

## Consequences

This keeps the client work moving and gives the central team executable
requirements. It also creates an integration risk: both sides can pass their
own tests and still disagree at the proxy, shared replay store, database, or
email boundary. S07 and the combined qualification phase exist to find those
differences before release.

## Approval

Approved by the user on 2026-08-30. The user assigned central implementation
to another team, directed this repository to proceed with gateway, connector,
provider, and qualification work through sub-agents, and asked that reasonable
decisions be recorded for later review.
