# Next architecture and security plan

Status: accepted gateway architecture and provider-neutral connector boundary, production implementation not started

Date: 2026-08-30

This document collects the accepted REST enrollment, conversation, recovery,
DPoP, and provider-neutral connector work for later implementation agents. The
user accepted ADRs 0023, 0025, 0026, and 0027 on 2026-08-29 and accepted ADR
0024's connector boundary on 2026-08-30. D06 also approves the exact test-only
Python fixture dependency recorded in ADR 0020. ADR 0024 does not approve a
connector CLI, state implementation, limits, runtime, dependency, provider
port, policy, package, platform, installation, or publishing choice. Those D05
decisions remain pending. The current product and protocol continue to
describe shipped version 1 behavior until implementation lands. Tests and
fixtures come before production changes under `docs/implementation-plan.md`.

ADRs 0023 and 0026 are accepted. PR `#28` merged T01 through T04 and C01,
and the user accepted the T03 and T04 gateway failure inventory on 2026-08-30.
That completes only the gateway review input. Gate A remains open until the
external central owner publishes and accepts S01. Nothing in this document
authorizes production gateway work before that gate.

`docs/architecture-pr-backlog.md` groups this work into pull requests,
cross-repository dependencies, red-test gates, and end-to-end qualification
lanes.

Production central URLs, signing systems, database guarantees, capacity,
trusted proxies, email delivery, and rollout dates are not available. Tests
use `docs/v2-fixture-profile.md` as a deterministic stand-in. That profile is
test-only and does not prove that the real central service implements any
transaction or security guarantee.

## N1: adopt the central REST enrollment contract

### Intended result

Keep the gateway's local MCP enrollment experience, but send registration,
verification, and verification-resend requests to the central REST API. Capture
the verification credential, DPoP key, and token binding inside the gateway.
Do not expose any part to the local MCP client.

ADR 0023 contains the accepted architecture, schemas, security rules, and the
production facts that still need central-owner confirmation.

### Scope

- Define stable gateway-owned local schemas for `register_agent`,
  `verify_email`, and `resend_verification`.
- Add a bounded central REST client for the three bootstrap operations.
- Map REST verification into the first fresh version 2 credential persistence
  transaction.
- Keep the authenticated central MCP business semantics while applying ADR
  0026's accepted DPoP authentication at the HTTP transport.
- Keep the shipped consuming poll and its 404-only MCP fallback as regression
  coverage only. The fresh version 2 target uses ADR 0025's fixed leased
  receive operation without runtime selection, probing, or fallback.
- Update the Node fake central service and the independent Python fixture with
  the accepted REST bootstrap routes.
- Update user and architecture documentation after production implementation.

### Out of scope

- Calling the supplied remote service during automated tests.
- Allowing remote plain HTTP.
- Moving permission, action, acknowledgement, or other authenticated tools from
  MCP to REST.
- Changing the public CLI, adding configuration, or accepting a central JWT at
  startup.
- Implementing message redelivery, JWT reissue, revocation, or intentional
  identity reset as part of N1 alone.
- Installing another HTTP, validation, or parsing dependency.

### Accepted choices and unresolved production facts

| ID | State | Contract |
| --- | --- | --- |
| N1-Q1 | Accepted | Use `/api/register` only. Do not probe `/api/register_agent` or fall back to MCP. |
| N1-Q2 | Production fact unresolved | The gateway needs a stable HTTPS base. Fixtures use only the test value in `docs/v2-fixture-profile.md`. |
| N1-Q3 | Accepted | ADR 0023 fixes the status and safe error pairs. Central must implement them. |
| N1-Q4 | Accepted | Remote `message` is optional; the gateway supplies the fixed local message when absent. |
| N1-Q5 | Accepted | Verification codes contain exactly six ASCII alphanumeric characters and are always redacted. |
| N1-Q6 | Accepted | Do not retry uncertain verification. For the same freshly enrolled version 2 identity, request a fresh recovery code and issue a new bound credential. |
| N1-Q7 | Accepted | Shipped version 1 polling remains regression-only. A fresh version 2 installation uses ADR 0025's leased receive operation with no runtime selection or fallback. |
| N1-Q8 | Accepted target, external implementation | Verification and every protected route enforce ADR 0026 DPoP with no bearer fallback. |

### Work order and gates

PR `#28` completed the gateway fixture and red-specification work represented
by N1-T1 through N1-T5, and the user accepted that gateway inventory. The
implementation rows remain blocked by Gate A and their external central
dependencies.

| ID | Owner | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| N1-D1 | Documentation | Freeze N1-Q1 through N1-Q8 in ADR 0023 | Complete | Accepted contract and external production facts are separated |
| N1-G1 | User | Review ADR 0023, including the fixed deadline and byte limit | Complete on 2026-08-29 | ADR status and approval section updated |
| N1-T1 | Test support | Add REST bootstrap behavior and fault controls to the Node fake central service | N1-G1 | Support tests pass without production changes |
| N1-T2 | Central fixture | Add the same REST bootstrap contract to the independent Python fixture | N1-G1, D06 | Fixture contract passes independently; this does not prove production central behavior |
| N1-T3 | REST client | Add red tests for request projection, bounded parsing, statuses, deadlines, cancellation, redirects, duplicate keys, and safe errors | N1-T1 | Failures are only missing production behavior |
| N1-T4 | Enrollment | Add red tests for credential interception, persistence ordering, tool-list change, first-credential publication, fresh-version-2 recovery, and uncertain verification | N1-T1, N1-T3 | Credential and data scans still pass |
| N1-T5 | End to end | Add red local and Docker flows for REST registration, verification, restart loading, polling, and acknowledgement | N1-T2, N1-T4 | Full failure inventory written |
| N1-G2 | User | Review the red suite and failure inventory | Complete through the accepted T03 inventory on 2026-08-30 | Gateway review input complete; Gate A still waits on external S01 and central-owner review |
| N1-I1 | Central REST | Implement the bounded REST bootstrap client with no new dependency | N1-G2 | N1-T3 passes |
| N1-I2 | Local MCP | Replace upstream bootstrap discovery with fixed local schemas and REST dispatch | N1-I1 | Bootstrap catalog and request tests pass |
| N1-I3 | Identity | Connect REST verification to atomic credential persistence and token-free local results | N1-I2 | N1-T4 passes |
| N1-I4 | Assembly | Remove the bootstrap dependency on a central MCP connection and preserve post-enrollment MCP behavior | N1-I3 | N1-T5 passes |
| N1-D2 | Documentation | Update product, protocol, status, setup guides, and accepted ADR references | N1-I4 | Documents describe the shipped behavior only |
| N1-QA | Release | Run checks, secret scans, packed-install tests, Docker E2E, OpenClaw, and Hermes qualification | N1-D2 | Green qualified release evidence |

N1-G2 is complete, but production implementation remains blocked by Gate A and
the external central work in `docs/implementation-plan.md`.

### Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| N1-A01 | List tools before enrollment while central MCP is unavailable | List the three fixed bootstrap tools without contacting central MCP |
| N1-A02 | Register with valid required fields | Send one exact JSON REST request and return a credential-free local result |
| N1-A03 | Register with `display_name` | Forward it only when supplied and reject unknown local fields |
| N1-A04 | Registration times out after transmission | Return a fixed uncertain-outcome error and do not retry |
| N1-A05 | Verify with a valid response | Extract and atomically persist the approved credential, return token-free success, and emit tool-list change; do not start receive before version 2 activation succeeds |
| N1-A06 | Verification persistence fails | Return failure, enable no authenticated work, and expose no JWT |
| N1-A07 | Verification response contains duplicate or nested credential fields | Fail closed and persist nothing |
| N1-A08 | Verification times out after transmission | Do not retry and do not report local enrollment success |
| N1-A09 | Repeat verification after enrollment | Reject locally before sending another REST request |
| N1-A10 | Resend returns a successful credential-free response | Return it without starting polling |
| N1-A11 | Any bootstrap response exceeds the approved byte or depth limit | Cancel or reject it, persist nothing, and return a fixed safe error |
| N1-A12 | Any bootstrap endpoint redirects | Reject without following the redirect |
| N1-A13 | Remote central URL uses plain HTTP | Reject before opening credentials, connecting, or sending user data |
| N1-A14 | Run the normal artifact scan | Find no email, code, request body, response body, or plaintext JWT in durable or normal diagnostic output |
| N1-A15 | Run verbose development mode | Redact every code value and JWT while retaining the approved non-credential transcript content |
| N1-A16 | Activate and receive after REST enrollment | Require `Authorization: DPoP`, a fresh proof, no bearer fallback, and the fixed version 2 leased-receive path |

### Likely file ownership

The implementation agent should confirm ownership against the active plan before
editing. Expected files are:

- `src/gateway-application.ts` for routing and assembly;
- a new project-owned central REST client module;
- `src/identity.ts` and `src/mcp-contract.ts` for verification and local schema
  contracts;
- `src/development-verbose.ts` for complete code redaction;
- `src/central-mcp.ts` and `src/mcp-contract.ts` to replace tool-argument token
  injection with transport authentication;
- `test/support/fake-central.ts` and `test/fixtures/central/` for independent
  contract fixtures;
- enrollment, CLI, MCP, and end-to-end tests; and
- product, protocol, setup, status, and ADR documents after implementation.

Do not change `src/notification-relay.ts` merely to complete REST enrollment.
ADR 0026 changes protected authentication, and ADR 0025 separately replaces
version 1 consumption with the version 2 leased receive operation.

## N2: add a central conversation and reply contract

### Intended result

Give every multi-turn exchange a stable central `conversation_id`, make
delivered but unacknowledged messages recoverable, and add an authenticated,
idempotent reply operation tied to the original inbound message.

ADR 0025 contains the accepted wire contract and unresolved production facts. The
live OpenAPI document checked on 2026-08-29 has no generic reply route, leaves
poll message items unspecified, and defines `call_action` without conversation
or reply correlation. Connector implementation cannot work around those gaps
locally.

### Scope

- Specify exact inbound message fields, message types, bounds, and lifecycle.
- Specify lease-based central redelivery of delivered but unacknowledged
  content without changing the gateway's content-free durable boundary.
- Add an idempotent reply route and matching MCP tool that route from the
  original inbound message instead of a caller-supplied username.
- Add the local token-free `reply_message` projection to the gateway.
- Preserve separate reply acceptance and `ack_message` operations.
- Extend both central test fixtures and crash tests before gateway production
  work.

### Out of scope

- Provider processes, provider SDKs, and provider session mapping.
- Persisting message or response content in the gateway or connector.
- Reinterpreting `call_action` without a reviewed central contract.
- Automatically replaying an uncertain provider turn.
- Changing the gateway CLI or webhook body.

### Work order and gates

PR `#28` completed the gateway fixture and red-specification work represented
by N2-T1 through N2-T5, and the user accepted the T04 inventory. N2-T0 remains
part of external S01 and still requires central-owner review.

| ID | Owner | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| N2-D1 | Central contract | Freeze the target conversation and message contract in ADR 0025 | Complete | The accepted client contract fixes messages, errors, idempotency, recovery, and activation; central OpenAPI remains external work |
| N2-D2 | Documentation | Reconcile the target with protocol v1's shipped delivery, acknowledgement, limits, and data boundary | Complete | The separate release contracts and version 1 regression boundary are explicit |
| N2-G1 | User | Review ADR 0025 | Complete on 2026-08-29 | ADR status and approval section updated |
| N2-T0 | Central tests | Add red server tests for conversation IDs, recovery, acknowledgement, idempotent replies, conflicts, authorization, bounds, and crash transactions | N2-G1 | Failures are only missing central production behavior |
| N2-T1 | Test support | Add conversation IDs, recoverable delivery, idempotent replies, conflicts, and fault controls to the Node fake central service | N2-G1 | Support tests pass without gateway production changes |
| N2-T2 | Central fixture | Add the same behavior to the independent Python fixture | N2-G1, D06 | Fixture contract passes independently; this does not prove central database transactions |
| N2-T3 | Local MCP | Add red tests for the token-free `reply_message` schema, buffered-message lookup, authenticated upstream dispatch, bounds, and safe errors | N2-T1 | Failures are only missing gateway behavior |
| N2-T4 | Relay | Add red crash tests for lease redelivery after an interrupted receive | N2-T1 | Gateway restart recovers content only through central after lease expiry |
| N2-T5 | End to end | Prove receive, reply, crash-window replay, duplicate suppression, and acknowledgement | N2-T2 through N2-T4 | Full failure inventory written |
| N2-G2 | User and central owner | Review the central and gateway red suites and failure inventories | Gateway T04 inventory accepted; external N2-T0/S01 inventory pending | Gate A closes only after the central owner publishes and accepts S01 |
| N2-C1 | Central service | Ship the approved conversation, recovery, and reply contract in a development environment | N2-G2, N2-T0 | Contract probes match the approved schemas over HTTPS or loopback HTTP |
| N2-I1 | Gateway MCP | Implement exact message correlation validation and the bounded local reply projection | N2-C1 | N2-T3 passes |
| N2-I2 | Relay | Implement the approved recovery operation without persisting content | N2-C1 | N2-T4 passes |
| N2-I3 | Assembly | Preserve buffered content until reply acceptance and later `ack_message` success | N2-I1, N2-I2 | N2-T5 passes |
| N2-D3 | Documentation | Update product, protocol, architecture, and accepted ADR references | N2-I3 | Shipped behavior and crash windows are accurate |
| N2-QA | Release | Run all unit, integration, Docker, artifact-scan, and interoperability checks | N2-D3 | Green qualified release evidence |

N1 and N2 design and gateway red-specification work are complete. Production
integration follows the serialized G01 through G04 order and external central
dependencies in `docs/implementation-plan.md`.

### Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| N2-A01 | Poll a connector-eligible message | Return exact bounded message and conversation IDs |
| N2-A02 | Receive later messages in the same conversation | Preserve the same `conversation_id` with new message IDs |
| N2-A03 | Reply to a buffered inbound message | Derive routing centrally and accept one reply |
| N2-A04 | Repeat an identical reply after an uncertain response | Return the original reply ID and enqueue nothing new |
| N2-A05 | Reuse the idempotency key with a different payload | Reject with the fixed conflict result |
| N2-A06 | Supply a target, sender, conversation, token, or provider session selector locally | Reject before any upstream call |
| N2-A07 | Reply to a message not in the current inbox | Reject locally without exposing whether another identity owns it |
| N2-A08 | Crash after central receive and before local processing | Redeliver the same logical message after the 60-second lease expires |
| N2-A09 | Crash after reply acceptance and before acknowledgement | Repeat reply safely, then acknowledge once |
| N2-A10 | Receive a malformed, oversized, credential-bearing, or conflicting message | Fail before journal, inbox, wake, or connector changes |
| N2-A11 | Reply operation has an uncertain first outcome | Do not invent success or issue an unsafe automatic retry |
| N2-A12 | Scan durable state and normal diagnostics | Find IDs and relay state only, with no message or reply content |

### Likely file ownership

- `src/mcp-contract.ts` for the local reply tool projection;
- `src/local-mcp.ts` and `src/gateway-application.ts` for reply dispatch and
  identity-safe central authentication;
- `src/notification-relay.ts` for the approved recovery flow;
- `src/notification-journal.ts` only for opaque recovery state, never content;
- `test/support/fake-central.ts` and `test/fixtures/central/` for contract
  fixtures; and
- protocol, architecture, runbook, and ADR documents after implementation.

The implementation agent must resolve overlapping ownership with N1 before
editing shared MCP, application, fixture, or documentation files.

## N3: build a provider-neutral connector foundation

### Intended result

Add a separately launched loopback connector that can receive one gateway's
wake, retrieve a message through local MCP, map its conversation to one
provider session, run one bounded provider turn, reply idempotently, and
acknowledge only after the reply is accepted.

ADR 0024 defines the accepted provider-neutral boundary. The gateway remains
unaware of Codex, Claude, and Gemini.

### Accepted boundary

Connectors are separate foreground companion processes. One connector is one
gateway's loopback webhook target, and one gateway and connector form one
provider pair. Running more than one provider requires independent pairs. The
gateway remains provider-neutral and keeps its existing two-option CLI.

The connector receives the authenticated ID-only webhook wake and retrieves
message content through the gateway's authenticated local MCP endpoint. It
owns a separate content-free correlation store containing only approved opaque
IDs and lifecycle state. The central credential and DPoP key never leave the
gateway, and the connector does not copy or proxy provider credentials.

A connector never starts a replacement provider turn merely because a prior
outcome is unknown. It recovers the exact turn when the approved provider
interface supports that operation. Otherwise it records an uncertain outcome
and waits for reviewed recovery.

### State model

```text
wake received
  -> message retrieved
  -> mapping persisted
  -> provider turn running
  -> reply pending
  -> reply accepted
  -> inbound acknowledged

provider turn running
  -> definite failure
  -> waiting for local approval
  -> uncertain outcome
```

Only the reviewed terminal states may advance to acknowledgement. A repeated
wake for any nonterminal message consults opaque connector state and must not
start a second provider turn.

### Common connector responsibilities

- Implement the existing bearer and HMAC V2 webhook receiver on literal
  loopback with the same timestamp, replay, header, body, and deadline rules.
- Act as the MCP client for `poll_messages`, `reply_message`, and
  `ack_message`. Do not expose delivery-control credentials to the provider.
- Keep at most one in-flight turn per conversation and enforce the reviewed
  global concurrency limit.
- Persist only the opaque correlation and lifecycle fields allowed by ADR
  0024.
- Bind provider execution to a user-selected working directory and fixed local
  policy. Reject every sender-controlled execution option.
- Submit the prompt through a structured stream or stdin, never shell parsing,
  argv, environment variables, or temporary files.
- Parse bounded structured provider events and return one bounded terminal
  payload or fixed status.
- Cancel and reap provider processes as a complete process group.
- Keep prompts, responses, tool data, permissions, and credentials out of
  connector state, gateway state, logs, diagnostics, metrics, and errors.

### Decisions required before tests or code

| ID | Decision | Required record |
| --- | --- | --- |
| N3-D1 | Connector executable, CLI, configuration, and working-directory interface | New CLI/configuration ADR and user approval |
| N3-D2 | Correlation-store format, access controls, encryption, deletion, and fresh-install lifecycle | New connector-state ADR and user approval |
| N3-D3 | Common implementation runtime, package layout, dependencies, and supported platforms | Foundation and dependency ADRs |
| N3-D4 | Fixed concurrency, provider timeout, event, stdout, stderr, and response limits | Protocol or limit ADR |
| N3-D5 | Provider port, local approval behavior, and which outcomes are terminal | Connector protocol and policy ADRs |
| N3-D6 | Packaging, installation, and publishing model | Distribution plan and user approval |

Do not infer approval for these choices from acceptance of ADR 0024's product
boundary.

### Work order and gates

| ID | Owner | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| N3-G1 | User | Review N3-D1 through N3-D6 | Accepted ADRs 0024 and 0025 | All foundation choices are accepted |
| N3-T1 | Test support | Build a fake authenticated gateway MCP/webhook pair and a scriptable fake provider process | N3-G1 | Support code passes independently |
| N3-T2 | Security | Add red tests for auth-before-body, replay, injection, environment scrubbing, limits, timeouts, and process cleanup | N3-T1 | Failures are only missing connector behavior |
| N3-T3 | State | Add red tests for mapping creation, resume, concurrency, repeated wakes, crash points, and uncertainty | N3-T1 | No test expects content persistence or prompt replay |
| N3-T4 | End to end | Add a fake-provider flow from central message through reply and acknowledgement | N3-T2, N3-T3 | Full failure inventory written |
| N3-C1 | CI | Run foundation tests on Linux, macOS, and Windows without provider credentials | N3-T4 | Red feature PR with classified failures |
| N3-G2 | User | Review the red suite and failure inventory | N3-C1 | Approval to implement the foundation |
| N3-I1 | Connector core | Implement authenticated wake, bounded local MCP client, cancellation, and safe errors | N3-G2 | N3-T2 passes |
| N3-I2 | Connector state | Implement the approved opaque correlation store and per-conversation serialization | N3-I1 | N3-T3 passes |
| N3-I3 | Provider port | Implement the frozen internal start, resume, recover, cancel, and event interface | N3-I2 | Fake provider passes N3-T4 |
| N3-QA | Foundation | Run all connector, gateway regression, artifact-scan, and packed-install checks | N3-I3 | Green foundation evidence |

### Foundation acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| N3-A01 | Missing or invalid wake authentication | Reject before parsing or MCP access |
| N3-A02 | Valid repeated wake for a running message | Return success and start no second turn |
| N3-A03 | Two messages for one conversation arrive together | Run them in order, never concurrently |
| N3-A04 | Messages for different conversations exceed the global cap | Queue by opaque ID without storing content |
| N3-A05 | Sender supplies shell text, model, cwd, session, tool, or approval fields | Treat them as message content or reject them, never as execution control |
| N3-A06 | Provider output exceeds a limit or contains invalid JSON events | Cancel safely and return a fixed terminal or uncertain state |
| N3-A07 | Provider times out | Terminate and reap the process group without replay |
| N3-A08 | Connector restarts after mapping but before turn start | Resume processing without creating another provider session |
| N3-A09 | Connector restarts after the provider may have acted | Recover the exact turn when supported or mark it uncertain |
| N3-A10 | Reply succeeds and acknowledgement fails | Keep the opaque state and repeat only the idempotent reply or acknowledgement step |
| N3-A11 | Provider session is missing or belongs to another project | Fail safe without silently rebinding the conversation |
| N3-A12 | Inspect connector state and normal output | Find only approved opaque IDs and lifecycle data |
| N3-A13 | Inspect provider process arguments and environment | Find no A2A body, response, webhook token, central JWT, or copied provider credential |
| N3-A14 | Provider asks for an unapproved tool | Preserve provider denial or local approval policy; never switch to bypass mode |
| N3-A15 | User selects no provider history persistence | Offer only one-shot behavior and report that multi-turn resume is unavailable |

## N4: qualify the three provider connectors

Provider adapters may proceed in parallel only after N3-I3 freezes the common
port. Each adapter gets its own provider protocol ADR, fake provider, red test
review, implementation, and manual qualification. Do not add three providers
to one unreviewed production change.

| Provider | Candidate interface to qualify | Required tests | Decision gate |
| --- | --- | --- | --- |
| Codex | Local stdio `codex app-server`; record `thread.id`, use `thread/resume` and `turn/start`, and consume terminal and approval events | Generated-schema compatibility, initialization, new thread, resume, streamed output, cancellation, approval, missing thread, exact-turn recovery, and process crash | Approve the Codex version, generated schema, process contract, sandbox, approval policy, and any dependency |
| Claude Code | Compare Agent SDK `query()` plus `resume` with headless `claude -p` structured output before selecting one | Session-ID capture, resume, strict MCP/tool policy, permission callback or safe denial, result bounds, definite error, process loss, and recoverability | Approve SDK versus CLI, exact version, dependencies, session-history behavior, and permission policy |
| Gemini CLI | Stable headless mode with `stream-json`; capture initialization session UUID and resume by exact ID | New session, UUID capture, resume, result event, sandbox and approval flags, malformed stream, retention cleanup, missing session, and uncertain turn | Approve CLI version, JSONL schema, invocation, sandbox, approval policy, and session-retention expectations |

### Codex work package

1. Pin a qualified Codex release and generate its App Server schema in a
   reviewed fixture location.
2. Write the fake App Server and red adapter tests before production code.
3. Use stdio by default. A WebSocket transport requires separate loopback,
   authentication, queue, and token-storage review.
4. Persist the returned `thread.id` before `turn/start` can perform stateful
   work.
5. Preserve App Server approval requests. The first release must fail safely
   if no reviewed local approval surface exists.
6. Prove whether `thread/read` can recover an exact completed response after a
   connector crash. If not, use the common uncertain state.
7. Run an opt-in local acceptance flow with an already authenticated Codex
   installation. Never place ChatGPT or API credentials in fixtures or CI.

### Claude Code work package

1. Write a short contract spike comparing the Agent SDK and headless CLI. The
   comparison covers structured session IDs, permission handling, cancellation,
   exact-turn recovery, prompt secrecy, versioning, and dependency cost.
2. Record and approve the choice before installing a package or writing
   production adapter code.
3. Persist `session_id` as soon as it is emitted and pass only that exact value
   to the approved resume interface.
4. Use a locked-down tool and permission policy. An allow list alone must not
   be treated as a deny list.
5. Disclose that normal resumable sessions contain prompts, tool calls, tool
   results, and responses in Claude-managed history.
6. Run an opt-in local acceptance flow using the user's existing Claude Code
   authentication. Never inject or copy an Anthropic credential.

### Gemini CLI work package

1. Pin a qualified Gemini CLI release and freeze the `stream-json` event subset
   the adapter accepts.
2. Use non-TTY stdin headless mode or another reviewed interface that keeps
   message content out of process arguments. Do not pass A2A content as a
   `--prompt` argument, and do not use experimental ACP as the baseline.
3. Capture the session UUID from the initialization event, persist it, and
   resume by that exact UUID.
4. Keep sandbox and approval controls fixed by local policy. Never use the
   unrestricted approval mode as an autonomous default.
5. Disclose Gemini-managed session content and retention. Test cleanup or a
   missing session without silently starting a replacement conversation.
6. Run an opt-in local acceptance flow with an already authenticated Gemini
   CLI. Never copy Google credentials into connector state or CI.

## N5: provider-neutral setup and product documentation

Complete this work after at least one provider connector passes its fake and
real-runtime qualification.

- Document that the gateway still starts with only
  `--webhook-url=<url>` and `--webhook-token-env=<name>`.
- Give each separate connector its approved startup and working-directory
  instructions. Do not add runtime selection to the gateway.
- Require the user to install, authenticate, and configure the provider. The
  gateway must not discover installations or edit Codex, Claude, or Gemini
  files.
- Explain that the connector handles A2A polling, reply, and acknowledgement,
  while the provider uses the user's existing MCPs, extensions, and tools for
  local work.
- Document provider-native history locations, retention, deletion, approval,
  sandbox, and no-persistence limitations.
- Add fake-provider CI lanes for every connector. Keep real-provider tests
  manual and opt-in so provider credentials never enter repository CI.
- Get explicit approval for connector installation and publishing before
  adding distribution tooling or release artifacts.
- Exclude branding, marketing copy, logos, and direct calendar or email
  integrations from this work.

## N6: bind central tokens with DPoP

### Intended result

Make a copied central JWT unusable without the gateway's private key. Central
verification issues an RFC 9449 DPoP-bound JWT, every protected REST and MCP
HTTP request carries a fresh proof, and every central resource endpoint rejects
missing, replayed, mismatched, or bearer use of that token.

ADR 0026 defines the accepted proof profile, verification response, protected
request headers, MCP transport change, nonce and replay behavior, credential
version 2, fresh-install boundary, and server interface.

This is a coordinated central and gateway change. Gateway proof generation
must not ship as a security feature until central enforces the proof at token
issuance and at every protected resource. There is no opportunistic fallback
from a DPoP token to bearer authentication.

### Scope

- Generate one P-256 key pair for a verification attempt and issue ES256 DPoP
  proofs with a public JWK.
- Require `POST /api/verify_email` to validate an issuance proof and return a
  JWT with `cnf.jkt` plus `token_type: "DPoP"`.
- Send `Authorization: DPoP <token>` and a fresh `DPoP` proof on protected REST
  and central MCP HTTP requests.
- Remove the central JWT from authenticated MCP tool schemas and arguments.
- Persist token type, JWT, algorithm, and private key atomically inside the
  existing encrypted credential envelope.
- Support bounded RFC 9449 nonce challenges and one safe retry only after an
  explicit challenge rejected before application dispatch.
- Require server-side replay detection across every replica that can receive
  the request.
- Support same-key reissue, revocation, key rotation, key loss, and
  email-control recovery only for an identity first enrolled under the fresh
  version 2 contract.

### Out of scope

- Changing local webhook bearer or HMAC authentication.
- Giving a provider connector, local MCP caller, or model access to the central
  JWT or DPoP private key.
- Claiming full OAuth or MCP OAuth compliance for the custom verification
  endpoint.
- Adding authorization-server discovery, refresh tokens, dynamic client
  registration, general configuration, or runtime discovery.
- Treating DPoP as body integrity, transport encryption, process isolation, or
  a replacement for encrypted credential storage.
- Selecting a central replay-cache product or deployment dependency from this
  repository.

### Required central interface

| Operation | Required contract |
| --- | --- |
| Verify | `POST /api/verify_email` carries `DPoP: <issuance-proof>` and no access-token authorization. The proof signs the exact external verification URL and has no `ath`. |
| Verify success | The fresh enrollment response includes required `token_type: "DPoP"`; the signed JWT contains `cnf.jkt` equal to the RFC 7638 thumbprint of the proof key. |
| Verify caching | Every verification response carries `Cache-Control: no-store`; central proxies and observability do not cache or log its body, proofs, nonces, authorization headers, or JWT claims. |
| Protected REST | Every route carries `Authorization: DPoP <jwt>` plus a fresh proof whose `htm`, query-free `htu`, `iat`, `jti`, optional `nonce`, and `ath` validate. |
| Central MCP | Every Streamable HTTP request carries the same two headers with a fresh proof for its actual method. Central tool schemas contain no `token` argument. |
| Issuance nonce | HTTP 400, exactly one `DPoP-Nonce` header, and `{"error":"use_dpop_nonce"}` before consuming the code. |
| Resource nonce | HTTP 401, exactly one `DPoP-Nonce` header, and `WWW-Authenticate: DPoP error="use_dpop_nonce"` before application dispatch. |
| Invalid proof | HTTP 400 with `invalid_dpop_proof` at issuance; HTTP 401 with a DPoP challenge at a protected resource. |
| Invalid token | HTTP 401 with a DPoP challenge and `invalid_token`; valid authentication without permission remains 403. |
| Version 2 recovery | Email-control verification for a freshly enrolled version 2 identity issues a token bound to a new key and revokes that identity's earlier version 2 tokens. Same-key reissue renews only a working version 2 credential. |

The server must validate the JWT and proof, compare the proof thumbprint with
`cnf.jkt`, compare `ath` with the presented token, and reserve the replay key
before reading or dispatching an application body. Reverse proxies must derive
the same external HTTPS URI as the gateway and trust forwarding headers only
from configured proxies.

### Accepted choices and unresolved production facts

| ID | State | Contract |
| --- | --- | --- |
| N6-D1 | Accepted | Use ES256 with P-256 and no runtime algorithm negotiation. |
| N6-D2 | Accepted | ADR 0026 fixes proof age, skew, nonce, header, replay, and capacity bounds. |
| N6-D3 | Production fact unresolved | Central must supply every canonical external HTTPS identifier. Fixtures use `docs/v2-fixture-profile.md`. |
| N6-D4 | Accepted | ADR 0026 fixes verification success, challenge, proof, and token error schemas. |
| N6-D5 | Accepted requirement, external implementation | Central must provide shared cross-replica nonce keys and atomic replay rejection. A fixture cannot prove the production mechanism. |
| N6-D6 | Accepted | Credential version 2 stores the DPoP token and encrypted PKCS#8 P-256 private key atomically. |
| N6-D7 | Accepted | Use same-key authenticated reissue for renewal and email-control verification for key replacement after fresh version 2 enrollment. |
| N6-D8 | Accepted | ADR 0026 fixes expiry, revocation, rotation, key-loss, and lost-response behavior. |
| N6-D9 | Accepted | The target starts from clean local state and a new version 2 enrollment. Shipped version 1 behavior remains regression-only and has no conversion or retirement date in this plan. |
| N6-D10 | Accepted | Use the service-specific RFC 9449 profile. A later move to standard OAuth and MCP authorization needs another ADR. |

### Work order and gates

PR `#28` completed the gateway fixture and red-specification work represented
by N6-T1 through N6-T5. N6-T6 remains part of external S01 and still requires
central-owner review.

| ID | Owner | Task | Depends on | Completion evidence |
| --- | --- | --- | --- | --- |
| N6-C1 | Central contract | Freeze N6-D1 through N6-D10 in the gateway target contract | Complete for the gateway; central publication remains external | Accepted proof, error, token, URI, storage, fresh-enrollment, and recovery rules are explicit |
| N6-G1 | User | Review ADR 0026 and its amendment to ADR 0019 | Complete on 2026-08-29 | ADR status and approval section updated |
| N6-T1 | Cryptography tests | Add independent vectors for ES256 proofs, RFC 7638 thumbprints, `ath`, URI projection, clocks, and malformed JOSE | N6-G1 | Red failures identify only missing gateway behavior |
| N6-T2 | Central fixtures | Add token issuance, `cnf.jkt`, proof validation, nonce, replay, DPoP errors, and token-free MCP schemas to both fixtures | N6-G1, D06 | Fixture contract passes independently. Simulated replicas test the contract but do not prove production shared replay state |
| N6-T3 | Credential tests | Add red tests for first credential version 2 publication, atomic token and key persistence, restart, corruption, mismatch, and artifact scans | N6-G1 | No test expects plaintext, content persistence, or version 1 conversion |
| N6-T4 | REST tests | Add red verification and polling tests for fresh proofs, nonce retry, unsafe retry rejection, headers, limits, cancellation, and safe errors | N6-T1, N6-T2 | Failure inventory contains no server ambiguity |
| N6-T5 | MCP tests | Add red tests for a fresh proof on every HTTP method, removal of token arguments, nonce handling before dispatch, reconnect, cancellation, and uncertain calls | N6-T1, N6-T2 | Existing local credential filters remain green |
| N6-T6 | Central service tests | Add red issuer, middleware, trusted-proxy, cross-replica replay, nonce, fresh-enrollment, reissue, recovery, and revocation tests in the central repository | N6-T2 | Central owner publishes S01 with failures caused only by missing production behavior |
| N6-G2 | User and central owner | Review the complete red suite and failure inventory | Gateway T03/T04 inventory accepted; external N6-T6/S01 pending | Gate A closes only after the central owner publishes and accepts S01 |
| N6-S1 | Central service | Implement and deploy disabled-by-default DPoP issuance and enforcement to the development environment | N6-G2, N6-T6 | External contract probes match the fixtures over canonical HTTPS URLs |
| N6-I1 | DPoP core | Implement key generation, public JWK export, thumbprints, proof signing, token hashing, clocks, and nonce memory with Node core | N6-S1 | N6-T1 passes without a new dependency |
| N6-I2 | Identity | Implement atomic credential version 2 persistence and restart loading | N6-I1 | N6-T3 passes |
| N6-I3 | Central REST | Add the issuance proof to verification and DPoP authentication to polling and other protected REST routes | N6-I2 | N6-T4 passes |
| N6-I4 | Central MCP | Add per-request DPoP transport authentication and remove central token schema projection and argument injection | N6-I2 | N6-T5 passes |
| N6-E1 | Fresh enrollment | Exercise first version 2 issuance, same-key reissue, and email-control recovery for a dedicated fresh identity | N6-I3, N6-I4 | Restarted gateway uses only the current bound version 2 token and key |
| N6-S2 | Central service | Enable enforcement only for dedicated fresh version 2 identities after the development gate passes | N6-E1 | Bearer use of every DPoP-bound token fails before application dispatch |
| N6-DOC | Documentation | Update accepted architecture, protocol, security model, runbook, and central integration guide | N6-S2 | Shipped behavior and remaining limitations are accurate |
| N6-QA | Release | Run unit, integration, Docker, two-replica replay, packed-install, artifact-scan, OpenClaw, and Hermes qualification | N6-DOC | Green qualified release evidence |

Production gateway implementation must not begin before N6-G2. Production
DPoP mode must not be enabled before N6-S1 proves server enforcement in the
development environment.

### Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| N6-A01 | Verify with a valid issuance proof | Issue one JWT with matching `cnf.jkt` and return `token_type: "DPoP"` |
| N6-A02 | Verify without a proof or with a bad proof | Reject before consuming the code or changing verification state |
| N6-A03 | Verification response lacks DPoP type or matching binding | Persist neither token nor key and enable no authenticated work |
| N6-A04 | Persist a valid verification result | Commit token, type, algorithm, and private key in one encrypted transaction |
| N6-A05 | Receive with a valid bound token and proof | Authenticate and return the accepted bounded version 2 leased-receive result |
| N6-A06 | Use `Bearer` with a DPoP-bound token | Reject even when the JWT signature and claims are otherwise valid |
| N6-A07 | Use the token with a proof signed by another key | Reject because the proof thumbprint does not match `cnf.jkt` |
| N6-A08 | Reuse a captured proof | Reject the replay on the same replica and a different replica |
| N6-A09 | Change method, path, external origin, token, or proof time | Reject before REST or MCP application dispatch |
| N6-A10 | Change only the receive query | Validate against the approved query-free `htu` while normal request validation still checks the query |
| N6-A11 | Receive one valid nonce challenge | Retry once with the nonce, a new proof, and a new `jti` |
| N6-A12 | Receive a second, malformed, or oversized nonce challenge | Stop with a fixed safe error and perform no further retry |
| N6-A13 | Verification or a tool call times out after transmission | Do not retry and report an uncertain fixed outcome where applicable |
| N6-A14 | Initialize, list tools, call a tool, reconnect, and close MCP | Use a fresh method-correct proof on every HTTP request |
| N6-A15 | Inspect a central MCP tool call | Find no token or proof in JSON-RPC params or tool arguments |
| N6-A16 | Restart with credential version 2 | Load the token and private key without exposing either and resume DPoP authentication |
| N6-A17 | Run the shipped version 1 regression suite | Preserve its recorded behavior without reading or converting that state in the future version 2 target |
| N6-A18 | Lose or rotate the key after fresh version 2 enrollment | Use email-control recovery and revoke the earlier version 2 tokens without bearer fallback |
| N6-A19 | Scan state, logs, diagnostics, metrics, temporary files, and transcripts | Find no plaintext token, private key, proof, nonce, email, or verification code |
| N6-A20 | Run through a trusted reverse proxy | Gateway and server agree on the external `htu`; spoofed forwarding headers do not alter it |

### Likely file ownership

- a new project-owned DPoP module for key, JWK, thumbprint, proof, nonce, and
  time handling;
- `src/identity.ts` for credential version 2 and binding validation;
- the new central REST client and `src/notification-relay.ts` for DPoP
  verification and polling;
- `src/central-mcp.ts` for a fresh proof on every transport request;
- `src/mcp-contract.ts` and `src/gateway-application.ts` for removal of upstream
  token arguments while preserving enrollment gates;
- `src/development-verbose.ts` for proof, nonce, and private-key redaction;
- `test/support/fake-central.ts` and `test/fixtures/central/` for the independent
  issuer and resource-server contract; and
- central service authentication middleware, JWT issuance, shared replay and
  nonce state, trusted-proxy handling, OpenAPI, and deployment configuration in
  the central repository.

An implementation agent must split central and gateway ownership explicitly.
Do not let a gateway-only pull request claim completion of N6.

## Combined dependency order

```text
N1 REST enrollment contract ----\
                                -> fresh version 2 enrollment and DPoP enforcement
N6 DPoP contract and server ----/

N2 central conversation/reply contract + N6 protected transport
  -> N3 connector foundation
     -> N4 Codex connector
     -> N4 Claude Code connector
     -> N4 Gemini CLI connector
        -> N5 setup, qualification, and distribution review
```

N1, N2, and N6 contracts are accepted, and D06 is complete. PR `#28` merged
T01 through T04 and C01, and the user accepted the T03 and T04 gateway failure
inventory. This completes the gateway side of the review only. Gate A remains
open until the external central owner publishes and accepts S01. N2 server
operations use N6 protected transport. Gateway changes overlap in the MCP
catalog, central clients, credential store, fixtures, application assembly,
and product documentation, so G01 through G04 stay serialized and blocked by
Gate A. ADR 0024's boundary is accepted. N3 through N5 remain blocked on the
concrete D05 connector CLI, state, limits, dependency, provider-port, policy,
packaging, installation, platform, and publishing decisions.
