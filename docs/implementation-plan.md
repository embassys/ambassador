# Implementation plan

Status: active for the accepted version 2 architecture

Updated: 2026-08-30

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

The user accepted ADRs 0023, 0025, 0026, and 0027 on 2026-08-29. They fix the
target REST enrollment, version 2 conversation and recovery, DPoP contracts,
and fresh-install cutover. The current product and protocol documents continue
to describe shipped version 1 behavior until the implementation and release
documentation land.

| ID | State | Result |
| --- | --- | --- |
| D01 | Complete | ADR 0023 fixes REST registration, verification, resend, bounds, safe errors, and recovery behavior |
| D02 | Complete | ADR 0025 fixes leased delivery, conversations, replies, terminal outcomes, acknowledgement, and activation |
| D03 | Complete | ADR 0026 fixes DPoP issuance and transport, credential version 2, reissue, recovery, and revocation; ADR 0027 removes in-place migration from scope |
| D04 | Complete | Accepted ADR status, active plan, review list, and central change request are synchronized |
| D05 | Complete | ADRs 0028 through 0031 fix the connector startup and retirement interface, state, policy, limits, provider-neutral port, runtime, dependency scope, private package layout, installation model, platform qualification, and publishing gates |
| D06 | Complete | ADR 0020 approves direct test-only use of `cryptography==50.0.0` with its existing wheel hash, license, fixture-only scope, image effect, and update policy |
| D07 | Complete | ADR 0032 permits local gateway, connector, and provider implementation against accepted fixtures before central deployment; real central compatibility, activation, qualification, and release remain externally gated |
| D08 | Complete | ADR 0033 closes W01 as deferred rather than passed, limits initial-release support and CI to macOS and Linux, and fixes the approval and native evidence required to restore Windows |

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

Green support work may merge before production behavior. Gateway red
specifications may merge after the user accepts their exact inventory. The
central red specification may merge after the central owner accepts its exact
inventory. Neither repository review closes Gate A by itself. ADR 0032 permits
local contract-first implementation before Gate A closes, but it does not
change the external review or release gate.

| ID | Repository | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| T01 | Gateway | Extend the Node fake central and independent Python container with the accepted version 2 contracts and fault controls | D06 | Both fixtures pass their own contract tests; the Python implementation computes DPoP independently |
| T02 | Gateway | Add full-process barriers, deterministic clocks, a separate sender client, proxy simulation, teardown, and artifact scans | T01 | Support tests pass on their intended CI platforms without production gateway changes |
| T03 | Gateway | Add the red REST enrollment, DPoP, credential version 2, token lifecycle, and transport suite | T01, T02 | Every expected failure maps to missing production behavior rather than a fixture assumption |
| T04 | Gateway | Add the red conversation, leased recovery, reply, completion, acknowledgement, and activation suite | T01, T02 | Every expected failure maps to missing production behavior rather than a fixture assumption |
| C01 | Gateway | Run unit and Node integration tests on Linux and macOS; run packaged Docker E2E on Ubuntu | T01-T04 | CI publishes a classified red failure inventory |
| S01 | Central, external | Add red issuer, DPoP middleware, proxy, replay, enrollment, message, reply, recovery, quota, and two-replica transaction tests | Accepted contracts | Central owner publishes a classified failure inventory in the central repository |
| GATE-A | User and central owner | Review T03, T04, and S01 failure inventories | C01, S01 | Written approval that failures represent the accepted contracts |

The gateway half of this gate is complete. PR `#28` merged T03, T04, and C01
after the user accepted their classified failure inventory on 2026-08-30.
Gate A remains open until the central owner publishes and accepts S01 in the
central repository. The merge records the reviewed gateway specification; it
does not stand in for central DPoP enforcement. ADR 0032 separately authorizes
G01 through G04 against the accepted fixtures and requires that evidence to be
labeled local rather than production central compatibility.

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
| S06 | Add same-key reissue, revocation, and email-control recovery | S03 | A stolen token cannot bind a replacement key; lost issuance and key loss recover through the accepted email-control flow |
| S07 | Run the production-like staging gate through the real HTTPS proxy and shared state | S02-S06 | Dedicated fresh-install identities pass black-box contract tests without credential-bearing logs |

The gateway repository cannot complete S01 through S07. Its fixtures prove
client and protocol behavior only. Production URLs, issuer and audience
values, signing setup, shared replay and nonce state, database transactions,
proxy peers, quotas, and rollout dates remain central-owner deliverables.

## Phase 3: gateway implementation

ADR 0032 permits G01 through G04 to begin against the accepted fixtures before
GATE-A. Do not enable a production DPoP path before S03 is deployed for
dedicated development identities and rejects bearer use of the same bound
tokens.

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| G01 | Implement P-256 DPoP proofs, nonce handling, encrypted credential version 2, and same-key replacement | ADR 0032, T03 approval | T03 cryptographic, restart, corruption, and artifact-scan cases pass locally; S03 remains required for live qualification |
| G02 | Move local bootstrap tools to bounded central REST enrollment | G01, accepted REST fixture contract | Registration, verification, resend, lost response, persistence ordering, and token-free local results pass; S02 remains required for live qualification |
| G03 | Authenticate all protected central REST and MCP requests with DPoP and remove MCP token arguments | G02, accepted DPoP fixture contract | Fresh-proof, nonce, cancellation, reconnect, bearer-rejection, and safe-error cases pass; S03 remains required for live qualification |
| G04 | Implement version 2 activation, leased receive, conversations, replies, outcomes, completion, and acknowledgement | G03, T04 approval, accepted conversation fixture contract | T04 passes without durable gateway message or reply bodies; S04 and S05 remain required for live qualification |

Serialize G01 through G04. They overlap in identity, credential, application,
MCP, relay, journal, fixture, and documentation files. An implementation agent
may split non-overlapping modules, but one owner must integrate shared files in
this order.

## Phase 4: qualification and cleanup

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| E01 | Qualify REST enrollment, DPoP, reissue, recovery, and bearer rejection | G01-G03, S07 | Node, Docker, packed-install, and staging checks pass |
| E02 | Qualify lease, reply, completion, acknowledgement, and every crash barrier | G04, S07 | One logical message, provider turn, reply, and terminal acknowledgement survive each tested interruption |
| E03 | Run bounded soak, outage, quota, shutdown, and complete artifact scans | E01, E02 | No credential, proof, nonce, code, message, reply, or tool content crosses its approved boundary |
| W01 | Deferred: qualify Windows under a new approved plan | ADR 0033 | Closed as deferred, not passed; supplies no initial-release evidence |
| G05 | Remove Python-literal MCP result normalization | S02 stable, E01, E02 | Native structured results pass fixtures and staging before compatibility code is deleted |
| G06 | Remove the version 1 404-only MCP polling fallback | S04 stable, E02 | The canonical leased receive path passes outage and recovery tests |
| G07 | Remove the development verbose transcript | Stable central machine-readable errors, E01, E02 | ADR 0022's option, tests, exception, and TODO are removed together |
| R01 | Review the gateway release | E01-E03, G05-G07 | Product, protocol, setup, security review, dependency audit, package, and macOS/Linux evidence match shipped behavior |

## Phase 5: connector and provider work

ADR 0024 accepts the separate provider-neutral connector boundary. The user
accepted ADRs 0028 through 0031 on 2026-08-30, completing D05 with these
connector-wide choices:

- connector executable, startup CLI, and explicit whole-provider state retirement;
- working-directory and local security policy inputs;
- content-free correlation-store technology, schema, access controls,
  encryption, fresh-install behavior, and retirement;
- runtime, dependencies, provider-neutral port, package layout, fixed limits,
  concurrency, and timeouts;
- provider approval and uncertain-turn behavior; and
- installation, packaging, supported platforms, and publishing gates.

After D05 and the accepted G04 contract, implement the provider-neutral
connector in the K01 through K04 order recorded in
`docs/architecture-pr-backlog.md`: fixtures, red suite, review,
implementation, then full fake-provider E2E. Only then start separate
Codex, Claude Code, and Gemini tracks. Each provider needs its own protocol and
dependency decision, fake adapter tests, red-suite review, implementation, and
manual opt-in qualification with an existing authenticated installation.
ADR 0033 limits K02 and the initial connector release to Linux and macOS; K02
must not add a Windows CI lane.

Real provider credentials never enter repository CI. Connector publication or
installation tooling still needs explicit user approval.

### Codex adapter track

CX01 accepts ADR 0034 for the Codex-first preview implementation path. It pins
Codex App Server 0.149.0 and its stable generated schema, selects one stdio
child per provider-port invocation, fixes the thread, turn, policy, recovery,
history, authentication, license, update, and containment boundaries, and
supplies the exact CX02 red test plan. The decisions remain available for
later user review, but that review does not block CX02 or CX03.

| ID | Task | Depends on | Completion evidence |
| --- | --- | --- | --- |
| CX01 | Record the Codex App Server adapter contract | K03 | ADR 0034 accepts the exact version, schema digest, protocol subset, policy, recovery, history, platform, containment, and update decisions for the preview path |
| CX02 | Add the fake App Server and classified red adapter specification | CX01 | Every ADR 0034 CX02 node, X01-X07, X08a-X08b, and X09-X27, fails only at the absent CX03 production boundary; Linux and macOS CI use no real Codex binary or credential |
| CX03 | Implement the Codex adapter against the frozen provider port | CX02 failure review | The complete CX02 inventory passes without a provider dependency, public control seam, input in argv, approval grant, credential copy, or blind turn replay |
| CX04 | Qualify one existing authenticated Codex 0.149.0 installation manually | CX03, K04 | Each claimed Linux or macOS target passes exact schema, two-turn resume, sandbox, cancellation, hard-crash containment, recovery, and artifact checks |

Codex App Server is currently documented as experimental and unsupported for
production workloads. CX04 may support only the approved Codex-first preview.
It does not close real-central, publishing, soak, or stable gates. A failed
hard-crash containment test leaves that provider/platform pair unsupported and
returns its containment mechanism for a new decision.

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

- The user accepted the T03 and T04 gateway inventory. Gate A still lacks the
  external S01 inventory and central-owner review. ADR 0032 allows local
  implementation to proceed but not production central claims or activation.
- The central implementation repository and owners must complete S01 through
  S07. This gateway workspace does not contain that production service.
- Production issuer, API resource, MCP resource, API base, and MCP endpoint
  values are unresolved. The fixture profile supplies test-only values.
- Central must confirm its signing, shared replay, nonce, revocation,
  idempotency, lease, quota, proxy, email, and rollout design before
  staging or release.
- The local user-authorized reset interface for an unreadable credential or
  uncertain revocation remains unresolved.
- D05 is complete. ADR 0032 permits K01 against the accepted G04 fixture
  contract. Provider-specific interfaces, versions, dependencies, platform
  support, and public distribution remain behind their later ADR and release
  gates.
- ADR 0033 closes W01 as deferred, not passed. Windows is unsupported for the
  initial release and is not an R01 dependency or CI lane.
