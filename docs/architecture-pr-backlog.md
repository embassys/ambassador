# Architecture PR backlog

Status: active implementation backlog for the accepted version 2 architecture

Date: 2026-08-30

This document turns the accepted architecture in ADRs 0023, 0024, 0025, 0026,
and 0027 into reviewable tasks and pull requests. It covers central REST
enrollment, DPoP,
recoverable conversations and replies, provider connectors, provider adapters,
end-to-end tests, compatibility cleanup, and release qualification.

The user accepted ADRs 0023, 0025, 0026, and 0027 on 2026-08-29, and accepted
ADR 0024's provider-neutral connector boundary on 2026-08-30. The user also
completed D06 by approving the exact test-only fixture dependency in ADR 0020.
This backlog does not approve another dependency, a connector CLI, state
technology or schema, cryptographic design, limit, package layout, provider
interface, approval policy, installation, platform claim, or publishing
change. The red-suite review and release gates remain mandatory.

Unknown production deployment facts do not reopen the accepted client
contract. Fixtures use the deterministic stand-ins in
`docs/v2-fixture-profile.md`. Those values are test-only and do not prove a
real central deployment, database transaction, shared replay guarantee,
trusted proxy path, email flow, capacity, or rollout date.

## Planning rules

- Keep the gateway at one foreground process, one webhook, one enrolled
  identity, and one authenticated loopback MCP endpoint.
- Keep provider processes and provider session state outside the gateway.
- Keep the gateway notification journal ID-only. This backlog does not adopt
  the durable message-body design described in the older central interface
  change request.
- Write fixtures and red tests before production behavior.
- Treat the central service, gateway, connector foundation, and each provider
  adapter as separate ownership areas.
- Do not merge a client change that needs an unavailable central contract.
- Do not claim DPoP protection until central enforces key binding at issuance
  and on every protected endpoint.
- Do not put real provider credentials or live central credentials in CI.
- Do not add a dependency, connector command, state format, or publishing path
  before its ADR is approved.

## Message-custody decision used by this backlog

An older revision of `docs/central-interface-change-requests.md` proposed a v2
custody transfer in which the gateway durably stored full message bodies. The
accepted ADR 0025 and the current change request use lease redelivery instead.

This backlog uses the ADR 0025 boundary:

```text
central retains full unacknowledged message
  -> central leases and returns it into gateway bounded memory
  -> connector replies through an idempotent operation
  -> gateway acknowledges only at the reviewed terminal point
```

D02 removed the conflicting durable-body text, and the user accepted that
contract on 2026-08-29. Central owners still need to implement and qualify it.
A future durable local inbox would need its own storage, encryption, quota,
migration, and deletion ADR. It is not part of this backlog.

## Pull request workflow

Support and fixture PRs must stay green and may merge before production work.
A feature's first behavior PR is a draft red-test PR. It records the expected
failures and remains unmerged until the user approves the failure inventory.
The implementation PR stacks on that test branch. The combined branch merges
only when every approved assertion passes.

For cross-repository work:

- central PRs own token issuance, authorization, messages, replies, and server
  deployment;
- gateway PRs own local MCP projection, credential custody, central clients,
  polling, wake, and acknowledgement;
- connector PRs own provider-neutral wake handling, provider execution, and
  opaque session correlation; and
- provider PRs own one provider protocol each.

Each PR description should include its dependency IDs, ADRs, test evidence,
data-boundary effect, rollback behavior, and a list of deliberately excluded
work.

## Dependency overview

```text
D01 REST contract ---------\
D02 message contract -------+--> D04 accepted plan, complete
D03 DPoP contract ---------/          |
D06 fixture dependency, complete -----+--> T01/T02 fixtures and E2E support
                                       +--> T03/T04 red gateway specifications
                                       +--> S01 red central specification

T03/T04 user acceptance --------\
                                 +--> Gate A -> S02 REST/native results -> S03 DPoP enforcement
S01 central-owner acceptance ---/

S03 -> S04 recovery and acknowledgement
S04 -> S05 idempotent reply and terminal outcomes
S03 -> S06 token lifecycle and recovery
S02/S03/S04/S05/S06 -> S07 staging contract gate

Gate A + S03 development enforcement -> G01 -> G02 -> G03
T04 + S04/S05 + G03 -> G04
S07 + G04 -> E01/E02/E03 gateway qualification

D05 + G04 -> K01 -> K02 -> K03 -> K04 connector foundation
K04 -> Codex, Claude, and Gemini adapter tracks in parallel

gateway qualification -> R01 gateway release review
first qualified adapter -> Q02 setup and distribution review
all requested adapters qualified -> Q03 combined release review
```

## Wave 0: contract gate and pending decisions

D01 through D04 and D06 are complete. The user approved the three target
contracts and the fixture-only cryptography dependency on 2026-08-29.
Canonical production URLs and other deployment facts remain central-owner
inputs. Tests substitute the fixture profile; production code must not do so.

| ID | State | Repository | PR title or task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| D01 | Complete | Gateway docs and central API docs | `docs: freeze REST enrollment and stable endpoint contract` | None | ADR 0023 fixes one registration path, bootstrap schemas, errors, limits, deadlines, recovery, and polling compatibility |
| D02 | Complete | Gateway docs and central protocol docs | `docs: freeze conversation, recovery, reply, and acknowledgement contract` | None | ADR 0025 fixes messages, leased recovery, replies, acknowledgement, idempotency, terminal status, bounds, and activation |
| D03 | Complete | Gateway docs and central security docs | `docs: freeze DPoP and token lifecycle contract` | D01 | ADR 0026 fixes the algorithm, URI rules, proof limits, nonce and replay rules, errors, credential version 2, reissue, revocation, rotation, and recovery; ADR 0027 removes migration from the target |
| D04 | Complete | Gateway docs | `docs: accept the next architecture and replace the active implementation plan` | D01, D02, D03, user approval | ADR status and approval sections, the implementation plan, review list, product and protocol governance, and shared ownership agree |
| D05 | Pending user review | Gateway or connector docs | `docs: approve connector startup, state, policy, limits, and packaging` | D02 and accepted ADR 0024 boundary | Separate ADRs fix the connector command, working directory input, state technology and schema, access control, encryption, deletion, runtime, dependencies, provider interfaces, concurrency, timeouts, approvals, terminal outcomes, packaging, installation, supported platforms, and publishing gates |
| D06 | Complete | Gateway fixture docs | `docs: approve DPoP verification for the independent Python fixture` | D03 | ADR 0020 approves direct test-only use of the existing hash-locked `cryptography==50.0.0` wheel, records its license and maintenance policy, and leaves the gateway dependency set unchanged |

The gateway uses the fixed accepted route split and never adds runtime
capability discovery or general endpoint configuration. Accepted lease
redelivery keeps full unacknowledged content at central and only IDs in gateway
SQLite.

## Wave 1: build test infrastructure and red specifications

### Gateway repository

| ID | Type | Proposed PR title | Depends on | Scope and completion evidence |
| --- | --- | --- | --- | --- |
| T01 | Merged green fixture | `test: add versioned central contract fixtures` | D04, D06 | The Node fake central service and independent Python fixture implement the accepted test contract and pass their own contract tests without production gateway changes. This proves fixture interoperability, not production central behavior. |
| T02 | Merged green test support | `test: add full-process fault and artifact-scan support` | T01 | Process barriers, a separate sender, trusted-proxy simulation, deterministic clocks, crash controls, cleanup, and bounded artifact scans pass on their intended platforms. |
| T03 | Merged red specification | `test: specify REST enrollment and DPoP gateway behavior` | T01, T02 | Unit, integration, local process, Docker, restart, nonce, replay, transport, and fresh-install credential version 2 cases have an accepted exact failure inventory. |
| T04 | Merged red specification | `test: specify conversation recovery and reply behavior` | T01, T02 | Message correlation, lease recovery, idempotent reply, conflict, crash-window, acknowledgement, content-boundary, and Docker cases have an accepted exact failure inventory. |

T03 and T04 used separate draft branches because they test different failure
domains. T03 owns credential and authentication failures. T04 owns custody,
correlation, and message lifecycle failures.

PR `#28` merged T03, T04, and C01 after the user accepted the gateway failure
inventory on 2026-08-30. This completes the gateway review input only. S01 and
central-owner review still block Gate A and every production gateway PR.

### Central repository, external ownership

The central production repository is not part of this workspace. Its owners
must implement and review S01. The gateway's fixture suite cannot stand in for
real database, proxy, email, shared-state, or deployment tests.

| ID | Type | Proposed PR title | Depends on | Scope and completion evidence |
| --- | --- | --- | --- | --- |
| S01 | Draft red PR | `test: specify central v2 enrollment, DPoP, recovery, and reply contracts` | D04 | Add independent server tests for exact REST and MCP schemas, native JSON results, token binding, nonce, replay, trusted proxy handling, two-replica replay, recovery, acknowledgement, reply idempotency, terminal outcomes, token lifecycle, rate limits, and safe errors. No production behavior is added. |

### Gate A

Do not begin production work until:

1. T01 and T02 are green;
2. the user reviews the T03 and T04 red failure inventories;
3. the central owner reviews S01's red failure inventory; and
4. each failure maps to an approved contract rather than a fixture assumption.

## Wave 2: implement the central service

These PRs belong in the central repository. They should keep new behavior
behind a server-owned rollout gate until S07 passes. The gate is not gateway
configuration and does not change the public gateway CLI.

| ID | Proposed PR title | Depends on | Scope | Completion evidence |
| --- | --- | --- | --- | --- |
| S02 | `feat: publish exact REST enrollment and native MCP results` | Gate A, S01 | Canonical registration, verification, resend, stable routes, fixed errors and limits, native structured MCP results, and no-store verification responses | D01 fresh-install cases pass with the exact accepted response contract |
| S03 | `security: issue and enforce DPoP-bound central tokens` | S02, S01 | Verify-time proof validation, `cnf.jkt`, `token_type: DPoP`, protected REST and MCP middleware, removal of MCP token arguments in the new contract, nonce challenges, replay protection, trusted-proxy URI reconstruction, and isolation of DPoP-bound tokens from bearer validation | DPoP conformance passes, including bearer rejection and replay on two replicas |
| S04 | `feat: add recoverable delivery and idempotent acknowledgement` | S03 | Stable immutable IDs, conversation fields, lease redelivery, authorization, acknowledgement semantics, quotas, retention, and machine-readable errors | A crash after delivery receives the same logical message after lease expiry; repeated acknowledgement has one result |
| S05 | `feat: add idempotent replies and terminal outcome states` | S04 | Server-derived routing from the inbound message, identity-scoped idempotency, reply conflicts, same-conversation response, terminal no-reply states, and separate acknowledgement | Repeating a reply after a lost response creates one outbound message and returns the original result |
| S06 | `security: add token reissue, revocation, rotation, and recovery` | S03 | Independently protected same-key reissue and email-control re-verification, atomic key rotation, revoked-token rejection, key-loss recovery, and lost-response behavior for a fresh version 2 identity | A fresh version 2 identity recovers without letting a stolen token claim the replacement key |
| S07 | `test: run the central staging contract gate` | S02, S03, S04, S05, S06 | Deploy the disabled contract to staging, run black-box HTTPS tests through the real proxy and shared replay state, enroll dedicated fresh identities, then enable it only for those identities | Staging matches the accepted REST schemas and routes plus the MCP, DPoP, recovery, and reply contracts with no credential-bearing logs |

S03 must authenticate and reserve a replay key before central parses or
dispatches a protected application body. S04 and S05 must use that middleware.
Do not add new bearer-only message or reply endpoints as an intermediate
release.

S03 completion includes a disabled development deployment for dedicated test
identities. This gives G01 a real enforcing issuer and resource server without
enabling the contract for ordinary identities. S07 remains the full staging
and deployment gate.

The central staging suite needs an approved fresh test identity and an
email-code delivery mechanism owned by the central test environment. Do not
add a production endpoint that returns verification codes.

## Wave 3: implement the gateway

These are stacked PRs on T03 and T04. None is independently releasable until
the full chain through G04 and E01 passes.

| ID | Proposed PR title | Depends on | Primary ownership | Completion evidence |
| --- | --- | --- | --- | --- |
| G01 | `security: add DPoP proofs and encrypted credential version 2` | Gate A, S03 enforcing in development for dedicated identities | New DPoP module, `src/credential-store.ts`, `src/identity.ts` | Independent proof vectors pass; token and PKCS#8 key persist atomically; restart, corruption, mismatch, and artifact scans pass from a fresh install |
| G02 | `feat: move enrollment bootstrap calls to central REST` | G01, S02, S03 | New central REST client, `src/gateway-application.ts`, bootstrap parts of `src/mcp-contract.ts` | Local bootstrap tools work without central MCP discovery; verification uses an issuance proof, validates binding, persists before success, and never exposes the credential |
| G03 | `security: authenticate protected central REST and MCP with DPoP` | G02, S03 | `src/central-mcp.ts`, `src/notification-relay.ts`, authenticated parts of `src/mcp-contract.ts` | Every protected HTTP request has a fresh proof; nonce retry is bounded; MCP tool arguments contain no token; bearer fallback fails closed |
| G04 | `feat: add recoverable conversations and idempotent replies` | G03, S04, S05, T04 approval | `src/notification-relay.ts`, `src/notification-journal.ts`, `src/local-mcp.ts`, `src/gateway-application.ts` | The gateway validates conversation fields, recovers bodies only from central, exposes token-free `reply_message`, retains content through reply acceptance, and acknowledges at the approved terminal point |

G01 must not broaden the credential file beyond the fields approved in ADR
0026. G04 may add opaque recovery state to SQLite only if the accepted central
contract requires it. It may not add message or reply bodies.

### Shared-file order

G02, G03, and G04 all touch application assembly and MCP projection. Serialize
them in that order. Do not ask parallel agents to edit
`src/gateway-application.ts` or `src/mcp-contract.ts` on separate branches.

## Wave 4: qualify the gateway end to end

| ID | Type | Proposed task or PR | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| E01 | Green E2E PR | `test: qualify REST enrollment and DPoP end to end` | G01, G02, G03, S07 | T03 is green against the Node fixture and Docker fixture; staging smoke covers HTTPS, real proxy URI handling, nonce, restart, reissue, and bearer rejection |
| E02 | Green E2E PR | `test: qualify recovery and reply crash windows end to end` | G04, S07 | T04 is green against both fixtures; deterministic process kills prove recovery after poll, one reply after lost acceptance, and one terminal acknowledgement |
| E03 | Qualification task | `record gateway soak, outage, recovery, and artifact-scan evidence` | E01, E02 | A bounded soak covers poll outages, nonce rotation, central restart, gateway restart, rate limits, mailbox pressure, reply conflicts, cancellation, recovery, and clean shutdown without content or credential artifacts |
| W01 | Gateway PR | `fix: qualify credential version 2 and packed install on Windows` | G01 | Strict user and SYSTEM DACL tests pass on Windows; the packed package installs, enrolls, restarts, polls, replies, and acknowledges through the Node fixture |

The Docker fixture runs on Ubuntu. Node fixture and unit coverage run on Linux,
macOS, and Windows. Windows remains a production release blocker until W01 is
green. A development-only release may keep the existing documented platform
limit, but it must not claim full qualification.

## Wave 5: remove temporary compatibility behavior

Each cleanup PR needs staging evidence that the old path is no longer used.
Keep these separate so one delayed server fix does not retain every temporary
path.

| ID | Proposed PR title | Depends on | Completion evidence |
| --- | --- | --- | --- |
| G05 | `cleanup: remove Python-literal central result normalization` | S02 native results stable, E01, E02 | All central MCP tools return native structured results in fixtures and staging; ADR 0021 code and tests are removed without weakening result validation |
| G06 | `cleanup: remove the 404-only MCP notification polling fallback` | S04 stable REST or MCP recovery route, E02 | One canonical protected receive path passes outage and recovery tests; the old consuming fallback and its state switch are gone |
| G07 | `cleanup: remove development verbose transcripts` | Stable machine-readable errors in S02 through S06, E01, E02 | `--verbose=true`, transcript code, tests, ADR 0022 exception, and the development TODO are removed; normal safe diagnostics remain sufficient |

## Wave 6: build the provider-neutral connector foundation

D05 may run while gateway implementation proceeds. Connector code waits for
G04 because it needs the final local `poll_messages`, `reply_message`, and
`ack_message` contracts.

| ID | Type | Proposed PR title | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| K01 | Green fixture PR | `test: add fake gateway and scriptable provider fixtures` | D05, G04 contract | A fake authenticated gateway exposes the three delivery-control tools; a fake provider emits deterministic session, turn, response, approval, crash, malformed, oversized, and recovery events |
| K02 | Draft red PR | `test: specify connector security, state, and crash behavior` | K01 | Red cases cover auth-before-body, replay, prompt injection boundaries, process argv and environment, state mapping, concurrency, repeated wakes, process-group cleanup, approval, exact-turn recovery, reply-before-ack, and uncertainty |
| K03 | Implementation PR | `feat: add the provider-neutral connector foundation` | K02 failure review | Implement the approved connector command, loopback wake receiver, bounded local MCP client, opaque state store, per-conversation serialization, global concurrency, cancellation, and provider port |
| K04 | Green E2E PR | `test: run the fake-provider conversation chain end to end` | K03, E02 | Central fixture to gateway to connector to fake provider to idempotent reply to acknowledgement passes two-turn resume, concurrent conversations, duplicate wakes, every crash barrier, restart, and artifact scans |

K04 must use the normal gateway and connector processes. It must not call
connector internals to move a message through the happy path. Test-control
operations may inject faults and inspect opaque IDs and statuses only.

## Wave 7: add provider adapters

The three tracks may run in parallel only after K03 freezes the provider port.
Each track has its own protocol decision, fake protocol, red test review,
implementation, and real-runtime qualification.

### Codex track

| ID | Type | Proposed PR or task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| CX01 | Docs and spike PR | `docs: approve the Codex App Server adapter contract` | K03 | Pin the Codex release and generated schema; fix stdio startup, thread and turn IDs, event subset, cancellation, approval policy, sandbox, recovery, history, license, and update policy |
| CX02 | Draft red PR | `test: specify the Codex App Server adapter` | CX01 | A fake App Server covers initialize, new thread, resume, streamed output, approval, cancellation, missing thread, exact-turn recovery, malformed events, oversized output, and process crash |
| CX03 | Implementation PR | `feat: add the Codex provider adapter` | CX02 failure review | The adapter passes the fake protocol and K04 chain, records `thread.id` before a stateful turn, resumes the exact thread, and fails safe when approval or recovery is unavailable |
| CX04 | Manual qualification task | `qualify Codex with an authenticated local installation` | CX03 | The full local central fixture, gateway, connector, and real Codex chain completes two turns in one thread in an isolated temporary workspace with tools denied or locally approved; no credential is copied into test state |

### Claude Code track

| ID | Type | Proposed PR or task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| CL01 | Docs and spike PR | `docs: select the Claude Code SDK or headless CLI contract` | K03 | Compare session timing, resume, permissions, cancellation, exact-turn recovery, prompt transport, dependencies, history, license, and platform support; approve one exact version before installation |
| CL02 | Draft red PR | `test: specify the Claude Code adapter` | CL01 | A fake selected interface covers session capture, resume, permission denial or callback, structured result, cancellation, missing session, process loss, malformed output, bounds, and recovery |
| CL03 | Implementation PR | `feat: add the Claude Code provider adapter` | CL02 failure review | The adapter passes the fake protocol and K04 chain, stores `session_id` before stateful work, applies the approved tool policy, and never passes prompts in argv or provider credentials in copied environment fields |
| CL04 | Manual qualification task | `qualify Claude Code with an authenticated local installation` | CL03 | The full local chain completes two turns in one session under the approved permission policy and isolated workspace; provider-managed history behavior matches the documentation |

### Gemini CLI track

| ID | Type | Proposed PR or task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| GM01 | Docs and spike PR | `docs: approve the Gemini CLI stream-json adapter contract` | K03 | Pin the CLI version and event subset; fix non-TTY stdin, UUID capture, resume, sandbox, approval, recovery, retention, license, and update policy; experimental ACP remains excluded |
| GM02 | Draft red PR | `test: specify the Gemini CLI adapter` | GM01 | A fake CLI covers initialization UUID, new session, resume, result event, approval and sandbox flags, malformed JSONL, output limits, missing session, retention cleanup, cancellation, and uncertain turn |
| GM03 | Implementation PR | `feat: add the Gemini CLI provider adapter` | GM02 failure review | The adapter passes the fake protocol and K04 chain, sends content through stdin, records the session UUID before stateful work, resumes the exact UUID, and never selects unrestricted approval mode |
| GM04 | Manual qualification task | `qualify Gemini CLI with an authenticated local installation` | GM03 | The full local chain completes two turns in one session under the approved sandbox policy and isolated workspace; provider history and cleanup match the documentation |

Real-provider tasks are manual and opt-in. CI must never download credentials,
sign into a provider, or depend on a user's provider history. A real-provider
failure blocks that adapter's release but does not block the other two tracks.

## Wave 8: product, installation, and release work

| ID | Type | Proposed PR or task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| R01 | Gateway release PR | `release: qualify the REST, DPoP, recovery, and reply gateway` | E01, E02, E03, W01, G05, G06, G07 | Product, protocol, ADRs, setup, status, package tests, OpenClaw and Hermes regression flows, platform matrix, security review, dependency audit, and release artifact all describe and contain the shipped gateway behavior |
| Q01 | CI PR | `test: run every fake provider adapter through one regression matrix` | K04 and each implemented adapter | Linux, macOS, and every provider-supported Windows lane run the fake full chain without provider credentials; unsupported combinations are documented rather than silently skipped |
| Q02 | Documentation PR | `docs: add provider-neutral connector setup and retention guidance` | First successful CX04, CL04, or GM04 | Users install and authenticate providers themselves; docs cover separate gateway and connector startup, working directory, sandbox, approvals, provider history, retention, deletion, and one-shot limitations |
| Q03 | Distribution decision and release PR | `release: package the approved connector and provider adapters` | Q01, Q02, explicit publishing approval | Each artifact has its own version, minimal contents, supported platforms, packed-install E2E, license notices, provenance, rollback plan, and no gateway runtime-selection option |
| Q04 | Combined qualification task | `record cross-provider soak and release evidence` | CX04, CL04, GM04, Q03 | Repeated multi-turn conversations, mixed concurrent conversations, provider restarts, gateway restarts, connector restarts, central outages, and reply uncertainty complete without duplicate turns, duplicate replies, leaked credentials, or persisted content |

R01 is a gateway release and does not wait for provider adapters. Connector and
adapter releases follow their own Q03 gate. This keeps central security and
message recovery from being blocked by provider integration work.

## End-to-end test architecture

### Test layers

| Layer | Runs where | Uses | What it proves |
| --- | --- | --- | --- |
| Protocol vectors | Linux, macOS, Windows | Deterministic Node tests | JOSE, JWK thumbprint, `ath`, URI projection, schemas, bounds, duplicate keys, safe errors, and state transitions |
| Node integration | Linux, macOS, Windows | `test/support/fake-central.ts`, raw MCP client, fake webhook | Fast gateway behavior, injected faults, cancellation, restart, local authentication, and artifact scans |
| Independent Docker E2E | Ubuntu CI | Pinned Python/FastAPI/FastMCP fixture and packaged gateway | Cross-language REST and MCP interoperability through a real gateway process |
| Central service E2E | Central CI | Real database, two service replicas, shared nonce and replay state, trusted proxy | Transactions, cross-replica replay, quotas, retention, fresh enrollment, recovery, and server logs |
| Staging smoke | Central deployment gate | Canonical HTTPS URLs and dedicated test identities | Proxy `htu`, TLS, email delivery path, rollout gates, DPoP enforcement, and deployed schemas |
| Fake-provider system E2E | Ubuntu CI and supported Node lanes | Central fixture, gateway, connector, fake provider | Complete delivery, provider turn, reply, acknowledgement, crash, resume, and deduplication chain |
| Real-provider qualification | Manual and opt-in | Existing authenticated provider installation | Actual provider protocol, session continuity, permissions, sandbox, history, cancellation, and packaging |
| Packed-install E2E | Every claimed platform | Packed gateway or connector artifact installed into an empty prefix | Published file set, executable startup, native SQLite load, state permissions, and the full local flow |

The independent Python fixture remains the main gateway Docker target. Do not
copy central production code into it. Central CI must separately test the real
database and shared replay implementation, because an in-memory one-worker
fixture cannot prove cross-replica atomicity.

### Required full-system scenarios

| ID | Scenario | Expected result | Primary PR |
| --- | --- | --- | --- |
| SYS-01 | Register, obtain a test code, and verify | Gateway sends exact REST JSON, creates an issuance proof, persists bound credential version 2, returns no token, changes the tool list, and starts protected polling | T03, E01 |
| SYS-02 | Restart after successful verification | Gateway decrypts the JWT and private key, sends a new proof, and exposes no credential in local MCP or process output | T03, E01 |
| SYS-03 | Use a copied JWT without the private key | Central rejects bearer use and a proof from another key before application dispatch | S01, S03, E01 |
| SYS-04 | Replay one proof through another replica | Shared central replay state rejects it inside the approved proof window | S01, S03, S07 |
| SYS-05 | Challenge verification and a protected request with nonces | Gateway retries each explicit challenge once with a new proof and `jti`; a second challenge stops | T03, E01 |
| SYS-06 | Drop the verification response after token issuance | Gateway reports uncertainty and does not retry; the approved reissue or re-verification flow recovers the identity | T03, S06, E01 |
| SYS-07 | Crash after central delivery and before local retrieval | Central redelivers the same logical message after lease expiry; no gateway file contains the body | T04, E02 |
| SYS-08 | Reply, commit centrally, then drop the response | Repeating the same request and idempotency key returns the original reply ID and creates no second message | T04, E02 |
| SYS-09 | Crash after reply acceptance and before acknowledgement | Restart repeats only the safe reply or acknowledgement step, then reaches one terminal state | T04, E02 |
| SYS-10 | Deliver two messages in one conversation | Connector creates one provider session, serializes the turns, and resumes the same opaque session ID | K02, K04 |
| SYS-11 | Deliver two conversations above the concurrency limit | Connector starts only the approved number, queues opaque IDs, and never stores content | K02, K04 |
| SYS-12 | Repeat a wake while a turn is running | Connector returns success without starting another provider turn | K02, K04 |
| SYS-13 | Kill the connector after session mapping but before turn start | Restart uses the stored mapping and starts one turn | K02, K04 |
| SYS-14 | Kill the connector after the provider may have acted | Exact-turn recovery returns the prior result when supported; otherwise state becomes `uncertain` and no prompt is replayed | K02, K04 and provider tracks |
| SYS-15 | Provider requests an unapproved tool or local approval | Connector preserves denial or the approved local flow and never changes to bypass mode | Provider red tests and manual qualification |
| SYS-16 | Provider emits malformed or oversized output or times out | Connector cancels and reaps the process group, returns a fixed state, and records no stream content | K02 and provider red tests |
| SYS-17 | Complete two turns through a real provider | Both turns use one provider session and the reply reaches the normal central interface | CX04, CL04, GM04 |
| SYS-18 | Inspect every local artifact and normal output | Find no message, prompt, response, tool data, email, verification code, JWT, DPoP key, proof, nonce, or copied provider credential outside its approved store | T02, E03, K04, Q04 |

### E2E process topology

The fake-provider E2E launches these real process boundaries:

```text
test sender client
  -> central fixture
  -> gateway process
  -> connector webhook process
  -> fake provider child process
  -> connector local MCP client
  -> gateway process
  -> central fixture reply queue
  -> test sender client
```

The happy path uses the approved normal central operation to send the first
message and normal central APIs to receive the reply. Test-control endpoints
may create faults, retrieve the deterministic verification code, inject
malformed or otherwise unreachable edge cases, and inspect opaque IDs or
status flags. They must not return central JWTs or provider and message
content.

### Crash barriers

Fixtures need deterministic barriers at these boundaries:

1. central selected a message but has not returned it;
2. gateway received a message but has not sent the wake;
3. connector stored the conversation mapping but has not started the provider;
4. provider emitted a session or turn ID but has not completed;
5. provider completed but connector has not sent the reply;
6. central accepted the reply but the connector has not observed success;
7. connector observed reply success but has not acknowledged the inbound
   message; and
8. central accepted acknowledgement but its response was lost.

Tests kill the owning process at each barrier, restart it, and assert which
operation may repeat. No production command-line flag or public HTTP route may
expose a crash barrier.

### Isolation and assertions

- Use temporary state and working directories with owner-only permissions.
- Keep Docker networks private to the test. Do not call the supplied remote
  plain-HTTP service from CI.
- Use fixture clocks and explicit release controls instead of reducing
  production security windows through user configuration.
- Keep the second test identity's DPoP implementation separate from the
  gateway production DPoP module. Shared RFC vectors are fine; importing the
  production signer into both sides would hide compatible mistakes.
- Run normal behavior through public REST, MCP, webhook, and provider protocol
  boundaries. Use test controls only for setup, barriers, and opaque state
  inspection.
- Capture provider argv and its allowlisted environment in the fake provider.
  Assert that neither contains prompts, A2A bodies, gateway credentials, or
  copied provider credentials.
- Scan gateway and connector output, credential files, correlation stores,
  SQLite, WAL, SHM, temporary paths, crash artifacts, and packed-install
  prefixes with unique sentinel values.
- Assert both presence and absence. A happy-path test must prove the reply
  arrived, the inbound message reached its terminal state, the provider session
  resumed, and no duplicate turn or reply exists.
- Always stop child process groups and containers in test teardown, including
  after assertion failure or timeout.

## Safe parallel work

These groups may run in parallel after their dependencies are green:

- D05 decision work and the external S01 red specification;
- S04 and S06 after S03;
- D05 decision work while later G01 through G04 proceed;
- the Codex, Claude Code, and Gemini tracks after K03; and
- G05, G06, and G07 after their separate staging gates.

Serialize these areas:

- any later amendment that changes accepted architecture and the active plan;
- G01 through G04 where they share identity, application, MCP, and relay code;
- central schema changes that touch the same token or message tables; and
- connector state and provider-port changes until K03 freezes both contracts.

## Definition of complete

The architecture work is complete only when:

- accepted documents match the deployed central and shipped gateway contracts;
- central enforces DPoP on issuance and every protected route;
- the gateway uses REST enrollment, stores one bound credential, and sends no
  token in MCP arguments;
- delivered but unacknowledged content is recoverable without durable gateway
  bodies;
- replies and acknowledgements are idempotent under their approved keys;
- the connector can resume one provider session per conversation without
  persisting content;
- every released provider passes its fake protocol and real-runtime
  qualification;
- temporary polling, normalization, and verbose compatibility paths are gone;
- claimed operating systems pass packed-install E2E and credential permission
  checks; and
- artifact scans and crash tests find no credential leak, content persistence,
  duplicate provider turn, or duplicate central reply.

Branding, direct personal-tool integrations, runtime discovery, gateway
bindings, service management, native installers, full OAuth migration, and OS
credential-vault adoption remain outside this backlog.
