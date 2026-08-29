# Implementation plan

Status: active for the accepted version 2 architecture

Updated: 2026-08-29

## Rules

- Read the product document, protocol, this plan, review list, and relevant
  accepted ADRs before work.
- Write fixtures, tests, and CI before production behavior.
- Keep the first gateway behavior PR red until the user reviews its failure
  inventory. Keep the first central behavior PR red until the central owner
  reviews its failure inventory.
- Do not select or install a framework, library, runtime, package manager,
  database driver, build tool, provider executable, or SDK before its ADR is
  explicitly approved.
- Keep gateway and connector durable state content-free. MCP bodies, message
  text, replies, prompts, tool data, email addresses, verification codes,
  credentials, proofs, and nonces must not enter SQLite, normal logs,
  diagnostics, temporary files, crash artifacts, or support bundles. ADR 0022
  permits only its temporary development stderr exception.
- Do not preserve obsolete enrollment, bearer, setup, binding, adapter,
  configuration, polling-fallback, or service interfaces as unreviewed
  compatibility code.
- Do not describe a fixture result as proof of a production central
  transaction, shared replay guarantee, proxy configuration, deployment, or
  email path.

## Accepted contract gate

The user accepted ADRs 0023, 0025, and 0026 on 2026-08-29. They fix the target
REST enrollment, version 2 conversation and recovery, and DPoP contracts. The
current product and protocol documents continue to describe shipped version 1
behavior until the implementation and release documentation land.

| ID | State | Result |
| --- | --- | --- |
| D01 | Complete | ADR 0023 fixes REST registration, verification, resend, bounds, safe errors, and recovery behavior |
| D02 | Complete | ADR 0025 fixes leased delivery, conversations, replies, terminal outcomes, acknowledgement, and activation |
| D03 | Complete | ADR 0026 fixes DPoP issuance and transport, credential version 2, reissue, recovery, revocation, and migration |
| D04 | Complete | Accepted ADR status, active plan, review list, and central change request are synchronized |
| D05 | Pending | ADR 0024 and separate connector CLI, state, policy, dependency, packaging, installation, and publishing decisions still need approval |
| D06 | Complete | ADR 0020 approves direct test-only use of `cryptography==50.0.0` with its existing wheel hash, license, fixture-only scope, image effect, and update policy |

The accepted contracts contain fixed values for development and test work.
Facts that only the central deployment owner can supply remain unresolved,
including production URLs, signing infrastructure, database guarantees,
capacity, proxy trust, and rollout dates. Tests use
`docs/v2-fixture-profile.md` as a deterministic stand-in for those facts. That
profile is test-only. It does not authorize production constants or claim that
the real service implements the contract.

## Dependency order

```text
D01 + D02 + D03 + D04 + D06 complete
              |
              +--> T01 central fixtures
                      |
                      +--> T02 process and artifact-scan harness
                              |
                              +--> T03 red REST and DPoP gateway suite
                              +--> T04 red conversation and recovery suite

external central S01 red suite --> central-owner review --> S02-S07 implementation

T03/T04 user review + enforcing development central
  -> G01 DPoP and credential v2
  -> G02 REST enrollment
  -> G03 protected REST and MCP transport
  -> G04 conversation recovery and replies
  -> E01/E02/E03 qualification
  -> G05/G06/G07 compatibility cleanup
  -> R01 gateway release review

G04 contract + D05
  -> K01-K04 connector foundation
  -> separate Codex, Claude Code, and Gemini adapter tracks
  -> connector distribution review
```

## Phase 1: fixtures, test support, and red specifications

Green support work may merge before production behavior. The red behavior
suites remain unmerged until their review gates pass.

| ID | Repository | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| T01 | Gateway | Extend the Node fake central and independent Python container with the accepted version 2 contracts and fault controls | D06 | Both fixtures pass their own contract tests; the Python implementation computes DPoP independently |
| T02 | Gateway | Add full-process barriers, deterministic clocks, a separate sender client, proxy simulation, teardown, and artifact scans | T01 | Support tests pass on their intended CI platforms without production gateway changes |
| T03 | Gateway | Add the red REST enrollment, DPoP, credential version 2, token lifecycle, and transport suite | T01, T02 | Every expected failure maps to missing production behavior rather than a fixture assumption |
| T04 | Gateway | Add the red conversation, leased recovery, reply, completion, acknowledgement, and activation suite | T01, T02 | Every expected failure maps to missing production behavior rather than a fixture assumption |
| C01 | Gateway | Run unit and Node integration tests on Linux, macOS, and Windows; run packaged Docker E2E on Ubuntu | T01-T04 | CI publishes a classified red failure inventory |
| S01 | Central, external | Add red issuer, DPoP middleware, proxy, replay, enrollment, message, reply, recovery, migration, quota, and two-replica transaction tests | Accepted contracts | Central owner publishes a classified failure inventory in the central repository |
| GATE-A | User and central owner | Review T03, T04, and S01 failure inventories | C01, S01 | Written approval that failures represent the accepted contracts |

D06 is complete. T01 may use the approved `cryptography==50.0.0` wheel for
independent fixture key and signature operations. The fixture must not share
the gateway's production verifier, and no other cryptographic, JWT, JOSE, or
OAuth dependency is approved by D06.

## Phase 2: central implementation, external repository

Central work is required before the gateway can honestly claim DPoP or durable
message recovery. It belongs in the central repository and stays behind a
server-owned rollout control until staging passes.

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| S02 | Publish the exact REST enrollment routes and native MCP results | GATE-A | Central contract tests pass for schemas, limits, errors, and no-store responses |
| S03 | Issue and enforce DPoP-bound tokens on protected REST and MCP transport | S02 | Bearer use, wrong-key proofs, replay across two replicas, and proxy URI mismatches fail before dispatch |
| S04 | Add leased delivery and idempotent acknowledgement | S03 | A lost receive or gateway crash redelivers the same immutable message; repeated acknowledgement has one result |
| S05 | Add idempotent replies, outcome lookup, and terminal completion | S04 | A lost reply response creates one outbound message and returns the original result |
| S06 | Add same-key reissue, revocation, email-control recovery, and legacy migration | S03 | A stolen bearer token cannot bind a replacement key; lost issuance and key loss recover through the accepted email-control flow |
| S07 | Run the production-like staging and migration gate through the real HTTPS proxy and shared state | S02-S06 | Dedicated identities pass black-box contract tests without credential-bearing logs |

The gateway repository cannot complete S01 through S07. Its fixtures prove
client and protocol behavior only. Production URLs, issuer and audience
values, signing setup, shared replay and nonce state, database transactions,
proxy peers, quotas, and rollout dates remain central-owner deliverables.

## Phase 3: gateway implementation

Do not begin G01 through G04 before GATE-A. Do not enable a production DPoP
path before S03 is deployed for dedicated development identities and rejects
bearer use of the same bound tokens.

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| G01 | Implement P-256 DPoP proofs, nonce handling, encrypted credential version 2, and same-key replacement | GATE-A, S03 development deployment | T03 cryptographic, restart, corruption, migration, and artifact-scan cases pass |
| G02 | Move local bootstrap tools to bounded central REST enrollment | G01, S02 | Registration, verification, resend, lost response, persistence ordering, and token-free local results pass |
| G03 | Authenticate all protected central REST and MCP requests with DPoP and remove MCP token arguments | G02, S03 | Fresh-proof, nonce, cancellation, reconnect, bearer-rejection, and safe-error cases pass |
| G04 | Implement version 2 activation, leased receive, conversations, replies, outcomes, completion, and acknowledgement | G03, S04, S05, T04 approval | T04 passes without durable gateway message or reply bodies |

Serialize G01 through G04. They overlap in identity, credential, application,
MCP, relay, journal, fixture, and documentation files. An implementation agent
may split non-overlapping modules, but one owner must integrate shared files in
this order.

## Phase 4: qualification and cleanup

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| E01 | Qualify REST enrollment, DPoP, reissue, recovery, and bearer rejection | G01-G03, S07 | Node, Docker, packed-install, and staging checks pass |
| E02 | Qualify lease, reply, completion, acknowledgement, and every crash barrier | G04, S07 | One logical message, provider turn, reply, and terminal acknowledgement survive each tested interruption |
| E03 | Run bounded soak, outage, quota, migration, shutdown, and complete artifact scans | E01, E02 | No credential, proof, nonce, code, message, reply, or tool content crosses its approved boundary |
| W01 | Qualify credential replacement and packed installation on Windows | G01 | DACL, atomic replacement, native SQLite, restart, and end-to-end tests pass |
| G05 | Remove Python-literal MCP result normalization | S02 stable, E01, E02 | Native structured results pass fixtures and staging before compatibility code is deleted |
| G06 | Remove the version 1 404-only MCP polling fallback | S04 stable, E02 | The canonical leased receive path passes outage and recovery tests |
| G07 | Remove the development verbose transcript | Stable central machine-readable errors, E01, E02 | ADR 0022's option, tests, exception, and TODO are removed together |
| R01 | Review the gateway release | E01-E03, W01, G05-G07 | Product, protocol, setup, security review, dependency audit, package, and platform evidence match shipped behavior |

## Phase 5: connector and provider work

ADR 0024 remains proposed. No connector test or production code starts until
D05 approves the separate product boundary and these choices:

- connector executable and CLI or configuration interface;
- working-directory and local security policy inputs;
- content-free correlation store, permissions, migration, and deletion;
- runtime, dependencies, package layout, limits, concurrency, and timeout;
- provider approval and uncertain-turn behavior; and
- installation, packaging, publishing, and supported platforms.

After D05 and G04, implement the provider-neutral connector in the K01 through
K04 order recorded in `docs/architecture-pr-backlog.md`: fixtures, red suite,
review, implementation, then full fake-provider E2E. Only then start separate
Codex, Claude Code, and Gemini tracks. Each provider needs its own protocol and
dependency decision, fake adapter tests, red-suite review, implementation, and
manual opt-in qualification with an existing authenticated installation.

Real provider credentials never enter repository CI. Connector publication or
installation tooling still needs explicit user approval.

## Release gates

| Gate | Required evidence |
| --- | --- |
| GATE-A | User and central owner accept the red gateway and central failure inventories |
| GATE-B | Central development deployment enforces DPoP and the accepted version 2 contract for dedicated identities |
| GATE-C | Gateway Node, Docker, packed-install, crash, security, and artifact-scan suites pass |
| GATE-D | Central staging passes through the production proxy and shared state |
| GATE-E | User reviews security findings, dependency audit, central compatibility, platform limits, and release artifact |

No green fixture, local mock, or Docker result can substitute for GATE-D. No
staging result can substitute for the gateway's local credential, crash, and
artifact tests.

## Current blockers and pending decisions

- The central implementation repository and owners must complete S01 through
  S07. This gateway workspace does not contain that production service.
- Production issuer, API resource, MCP resource, API base, and MCP endpoint
  values are unresolved. The fixture profile supplies test-only values.
- Central must confirm its signing, shared replay, nonce, revocation,
  idempotency, lease, quota, proxy, email, migration, and rollout design before
  staging or release.
- The local user-authorized reset interface for an unreadable credential or
  uncertain revocation remains unresolved.
- ADR 0024, connector state and CLI, provider interfaces and dependencies,
  packaging, installation, publishing, and supported-platform decisions remain
  pending.
