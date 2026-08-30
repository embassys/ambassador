# Decisions to review

## 2026-08-30: Version 2 gateway recovery boundaries used by G04

- An acknowledgement whose successful response is lost is recoverable after a
  restart from the existing journal's opaque message ID only. Startup suppresses
  the stale webhook wake but retains that ID until either central redelivers the
  immutable body or the repeated idempotent acknowledgement returns the exact
  `acked` result. Only then does the gateway delete the row. No body, outcome,
  reply, or tool argument is added to durable state.
- A terminal receive-contract failure stops the version 2 receive loop without
  tearing down content-free outcome, start-lookup, or acknowledgement recovery
  tools. Authentication failures still disable authenticated work. This keeps a
  malformed batch from being retried while preserving the caller's safe recovery
  operations.
- The T04 fixed-route assertion permits protected `/mcp` catalog traffic from
  G03, but still proves that receive and all conversation lifecycle operations
  use only their fixed REST routes and never call the central MCP message tools.
- T04 explicitly selects the accepted version 2 process fixture. When the test
  clock is advanced to the host wall clock, the fixture reissues its seeded,
  fixture-only credentials at that deterministic time so a calendar-day shift
  cannot turn conversation tests into unrelated token-expiry failures.

Updated: 2026-08-30

## Accepted on 2026-08-29

- ADR 0023 accepts REST bootstrap enrollment through `POST /api/register`,
  `POST /api/verify_email`, and `POST /api/resend_verification`. The gateway
  owns bounded local MCP projections, never probes the older route or MCP as a
  fallback, and uses email-control recovery for lost issuance, key loss, or
  rotation.
- ADR 0025 accepts version 2 linear, text-only conversations, 60-second central
  delivery leases, immutable unacknowledged content, idempotent starts and
  replies, explicit terminal outcomes, separate acknowledgement, and an atomic
  per-identity activation step. Gateway durability remains ID-only.
- ADR 0026 accepts the P-256 and ES256 DPoP profile, proof and nonce bounds,
  transport authentication for protected REST and central MCP, 24-hour bound
  tokens, same-key reissue, credential version 2, email-control recovery,
  revocation, and no bearer fallback.
- ADR 0027 accepts a fresh-install version 2 cutover. The shipped current API
  remains a regression baseline, while the future API has no version 1
  credential conversion, mailbox migration, mixed-version runtime mode,
  discovery, probe, or fallback.
- D01, D02, D03, and the D04 contract gate are complete. These decisions
  approve the target contract and its test specifications. They do not assert
  that the central service has implemented or deployed it.
- D06 approves direct test-only use of the already locked
  `cryptography==50.0.0` manylinux x86-64 wheel for independent P-256 and
  ECDSA operations in the Python fixture. ADR 0020 records its exact hash,
  license, scope, image effect, and update policy. T01 through T04 and C01 are
  now merged.

## Accepted on 2026-08-30

- The user accepted the exact T03 and T04 gateway failure inventory and asked
  to merge the completed work. PR `#28` merged T03, T04, and C01. This
  completes the gateway review input to Gate A. The external S01 inventory and
  central-owner review are still required before real-central qualification
  or production activation.
- ADR 0024 accepts separate foreground provider connectors while the gateway
  and its CLI remain unchanged. One gateway, connector, and provider form one
  pair. The connector receives the loopback webhook wake, retrieves content
  through the local gateway MCP endpoint, and owns content-free correlation
  state. The central credential remains in the gateway, provider credentials
  remain in the provider runtime, and the connector never blindly replays an
  uncertain provider turn.
- ADRs 0028 through 0031 were accepted on 2026-08-30 and complete D05. Real
  provider interfaces, versions, dependencies, support claims, and public
  distribution remain behind their later ADR and release gates.
- ADR 0032 was accepted on 2026-08-30. It lets local gateway, connector, and
  provider work proceed against the accepted independent fixtures while the
  central team implements S01 through S07. Fixture results remain local
  evidence and cannot support production central or release claims.

## Implementation judgments recorded for later review

These choices unblock contract-first implementation but are not additional
user-approved ADRs. A conflicting central or platform requirement returns the
affected choice for review rather than silently changing the client contract.

- The external central specification uses one shared authenticated
  non-receive counter for REST and MCP: 120 attempts per rolling 60 seconds.
  It charges malformed and idempotent attempts, while a denied conversation
  start still returns `recipient_unavailable` to preserve non-enumeration.
- Central message acceptance records an immutable quota-charge ledger.
  Acknowledgement releases the recipient mailbox charge and any applicable
  sender and sender-recipient start charges exactly once in the same
  transaction.
- Central email matching uses the named `email-comparison-v1` rule: UTF-8
  bytes with only ASCII `A` through `Z` folded to lowercase. Enrollment and
  recovery codes expire after ten minutes, are stored as keyed HMAC
  verifiers, and allow at most ten failed attempts per active code.
- The central MCP handoff fixes explicit request, response, nesting, token,
  session, concurrency, and native-result limits; rejects JSON-RPC batches;
  and uses one content-free `-32002` application-error projection. These
  values need central capacity evidence at S07.
- Central rollout has disabled, development, staging, and production states.
  Rollback stops new issuance and activation but never downgrades an issued
  DPoP identity to bearer or version 1 delivery.
- G01 keeps current version 1 regression access and fresh version 2 target
  access as separate fail-closed APIs. There is no version migration or
  automatic replacement between them. A legacy token accessor must reject a
  version 2 credential.
- Version 2 same-key replacement is accepted locally only for an unchanged
  issuer, subject, ordered audiences, P-256 key, and thumbprint, with a new
  token ID and a later expiry. An authentication-failed identity cannot enter
  this path.
- POSIX version 2 credential replacement uses the reviewed atomic file path.
  Windows replacement code may remain fail-closed, but ADR 0033 makes it
  unsupported and excludes it from initial-release evidence.

## Accepted Windows deferral

- ADR 0033 limits the initial gateway and connector release to macOS and
  Linux. Windows has no CI lane or setup claim. The platform-neutral npm
  package is not a Windows-qualified artifact or support claim.
- W01 is closed as deferred, not passed, and no longer gates R01. K02 must not
  add a Windows lane.
- Re-enabling Windows requires a new approved plan plus native credential,
  connector startup and environment security, state, process-containment,
  packed E2E, artifact-scan, and restored CI evidence. Platform-neutral or
  injected fail-closed tests are insufficient.
- G02 keeps the shipped version 1 bootstrap assembly as a regression-only
  test path and selects the fresh version 2 enrollment assembly only through
  an internal application/test seam. That seam is not a CLI option,
  environment setting, route probe, or runtime capability selector. The
  version 2 assembly requires one immutable expected issuer and ordered API
  and MCP audience profile. Tests inject the fixture-only profile; release
  activation remains blocked until the central owner supplies the production
  profile and G03/G04 complete the coordinated protected path.
- G02 uses Node core HTTP and HTTPS for bounded enrollment so cancellation can
  destroy and await the exact request and duplicate nonce headers remain
  observable. Tests that inspect request and response bytes inject the
  existing fetch observer explicitly; that observer is not present in the
  release assembly.
- G02 stops after durable version 2 enrollment and does not enter the legacy
  bearer relay. Scheduled authenticated same-key reissue remains G03 work
  because it requires the protected DPoP REST transport; G02 reuses G01's
  credential replacement primitives but does not dispatch reissue itself.
- The K02 pre-implementation inventory is accepted under the user's delegated
  implementation judgment with 69 top-level nodes: 68 exact reviewed failures
  and one loader guard. K03 owns the repository-only connector build, stage,
  packed-check, state-fault, capacity, retirement, dispatch-proof, and account
  home test seams described in `test/k02-failure-inventory.md`. None is a
  public CLI, configuration, packaged crash control, provider qualification,
  publishing approval, or Windows support claim.
- The K03 implementation read found and corrected two K02 assertions that
  contradicted the accepted ADRs. Q03 now observes the exact
  `poll_messages` request `{timeout:0}` instead of a nonexistent
  `message_ids` selector. S13 now requires startup to classify a nonexact
  retirement marker as `connector_state_unavailable`, reserves
  `connector_state_retired` for the exact 28-byte marker, and leaves prefix
  repair solely to confirmed `retire-state`. The reviewed node count and
  production contracts are unchanged.

## Accepted D05 package

ADRs 0028 through 0031 use the user's instruction to choose reasonable
defaults and record them for review. The user accepted all four records on
2026-08-30:

- ADR 0028 accepts three provider-specific foreground binaries. `start` has
  exactly four required named options for a loopback port, token environment
  reference, canonical absolute working directory, and explicit
  `read-only` or `workspace-write` maximum policy. The gateway MCP endpoint and
  webhook path stay fixed. A separate confirmed `retire-state` command first
  publishes a permanent fail-closed tombstone and then removes only one
  provider's allowlisted correlation artifacts. The retired location is never
  reused; a future design would need a different versioned location and new
  identity proof while preserving the old tombstone.
- ADR 0029 accepts one fixed per-provider SQLite store and extends the already
  pinned `better-sqlite3` scope. It uses a
  fresh-install-only schema, Node-core scrypt, AES-256-GCM encrypted IDs,
  keyed indexes, provider and working-directory scope binding, exact
  platform-qualified filesystem protections, acknowledgement-based message
  cleanup, and indefinite conversation mapping retention until explicit
  whole-provider retirement. Closed conversation tombstones remain until that
  retirement, with a 100,000-row lifetime ceiling and a 256 MiB database cap.
  Restoring both encrypted databases together to an older, mutually consistent
  snapshot can replay local correlation state; the design detects mismatched
  or partial rollback but cannot prevent that same-user backup rollback.
- ADR 0030 accepts the provider-neutral `start`, `resume`, `recover`, and
  `cancel` port; exact webhook and process bounds; one turn per conversation;
  two turns globally; a 100-ID queue; fail-closed approval, cancellation, and
  uncertainty; exact ADR 0025 completion mapping; reply-before-ack ordering;
  an absolute non-resetting provider deadline, and one non-resetting
  content-free central retry schedule.
- ADR 0031 accepts extending the Node 24, TypeScript, pnpm,
  `node:test`, Biome, Zod, MCP client, and Node-core toolchain to connectors,
  with no new foundation framework. It proposes shared repository source
  compiled directly into separate Codex, Claude, and Gemini artifacts,
  exact-version `npx` usage, fake-provider CI, manual real-provider
  qualification, a separately approved `next` preview gate, and a later
  `latest` stable gate. A provider/platform is supported only after hard-crash
  containment and recovery qualification. Publication must bind the public
  source commit to the exact tarball digest and verify the resulting registry
  provenance after publication.

This approval completes the provider-neutral D05 foundation decisions. ADR
0032 permits K01 against the accepted G04 fixture contract. Codex, Claude
Code, and Gemini still require separate
executable or SDK, version, protocol, sandbox, approval, history, license, and
platform ADRs.

## K03 test-determinism corrections

- O05 now sends distinct valid authenticated wakes while it tests coalescing
  before the durable retry time. The approved injected-clock default had made
  its first repeated wake byte-identical to the original request, which is an
  ADR 0030 replay and must remain a `409`, not coalescing evidence. The HMAC,
  replay rule, retry intervals, and coalescing behavior are unchanged.
- O03 and O06 now observe the exact durable `retry_kind` and absolute
  `retry_not_before_ms` before advancing their manual clocks. Observing the
  fake proxy's request was not evidence that the connector had received the
  simulated transport result and committed its schedule. This changes only
  test ordering; production scheduling and every accepted interval remain
  unchanged.
- O06 filters the proxy's raw MCP `initialize` record only when comparing the
  ordered delivery-control tool names. The proxy still retains that record,
  every defined tool remains in exact order, and separate MCP session and
  handshake evidence remains required.
- O06 treats the fixture's absent pre-ack tombstone as not acknowledged, using
  the same existing `?? false` semantic assertion as its other blocked-result
  vectors. The fake gateway continues to expose a tombstone only after exact
  acknowledgement, and later acknowledged-tombstone assertions remain exact.

## Test-only stand-ins

The user authorized reasonable stand-ins for production facts that are not yet
available. `docs/v2-fixture-profile.md` supplies those values to fixtures and
tests only. It does not supply production constants, approve a central
deployment, or prove real email, database, proxy, token-signing, replay,
revocation, lease, or quota behavior.

A test or implementation PR must label every value taken from the fixture
profile. Production code must not compile those values in as central product
constants. Staging work replaces each stand-in with a value confirmed by the
central owner and returns a material contract difference for review.

## Active architecture and dependency decisions

- T03-S03 treats protected REST as transport-observational until a legitimate
  protected REST operation occurs. A full-lifetime credential does not permit
  an early reissue, probe, activation, receive, legacy poll, or mixed-mode
  request merely to exercise the transport. T03-S04, U01 through U07, A01, and
  C01 through C02 own protected REST proof coverage; G04 owns activation and
  receive startup. This preserves the accepted task boundary while validating
  every protected REST request that is actually observed.
- T03-L01 advances its internal fixture clock by 43,201 seconds before it
  expects an exact-boundary protected API request. That makes scheduled
  same-key reissue legitimately due, so its 4,096-byte token, 1,024-byte key,
  8-KiB plaintext, generated-header, authorization, and proof bounds do not
  imply an otherwise forbidden startup probe or early reissue.
- T03-U04 seeds its revoked-token condition through the accepted revocation
  request body, `{"scope":"identity"}`. The previous empty request was rejected
  as `invalid_request` before it could establish the authentication-failure
  condition that U04 is intended to test.
- T03-U05 explicitly selects the internal version 2 fixture assembly for its
  first fresh enrollment. Its later starts intentionally omit that seam and
  select protected transport from the stored outer credential-version
  discriminant; this does not add production discovery, fallback, or migration.
- T03-A01 likewise selects the internal version 2 fixture assembly for the
  enrollment phase it is explicitly scanning. Its second start selects the
  protected path from the persisted version 2 discriminant.
- T03-A01 also enables the existing enrollment-fetch observation seam for its
  first phase. Without that internal seam, the test's global observer sees the
  later protected reissue proofs but cannot count proofs sent through G02's
  native Node HTTP bootstrap implementation.
- T03-P01 ignores bodyless MCP `GET` and `DELETE` requests when it searches the
  captured stream for a JSON-RPC `tools/call`. Those transport requests remain
  mandatory and are validated independently in the same test.
- T03-C01/C02 use a 10-second wall-clock bound for cross-process reissue
  observations. The previous 2,000 parent event-loop-turn bound could expire
  before the separately spawned gateway initialized Node's HTTP client, even
  while that worker remained healthy and running.
- T03-C01/C02 now seed and observe the credential path selected by the real
  platform path resolver and pass that exact path to their worker. The previous
  hard-coded Linux state path left a macOS child unenrolled, so it could not
  exercise protected reissue or publication.
- The one permitted uncertain scheduled-reissue repeat waits 10 milliseconds
  in process, reuses the operation's lowercase UUID v4 idempotency key, and
  creates a fresh proof. Redirects, HTTP results, malformed responses, and
  persistence failures do not use this exception. Production qualification
  should confirm whether the fixed backoff needs a different bounded value.
- D05 is complete. ADRs 0028 through 0031 contain the accepted connector
  foundation decisions. ADR 0032 permits K01 against the accepted G04 fixture
  contract before the external central service is ready.
- D07 is complete. Gate A and S07 now gate live central qualification,
  activation, and release rather than local implementation.
- Each Codex, Claude Code, and Gemini adapter still needs its own exact
  executable or SDK version, protocol schema, dependency decision, sandbox and
  approval policy, history behavior, supported platforms, and update policy.
- The private package and installation model is accepted. Public-repository
  conversion, publish jobs, preview or stable publication, and support claims
  remain unapproved until their later gates. The gateway CLI stays unchanged.
- The local user-authorized interface for intentional identity reset,
  unreadable credentials, and uncertain revocation remains undecided. Ordinary
  authentication or key failure must not enter recovery or overwrite a
  credential automatically.

## Production facts still required

The accepted client contract uses fixture stand-ins until the central owner
provides these facts:

- canonical HTTPS issuer, API base and resource, MCP resource, and stable
  `/mcp` endpoint;
- exact deployed OpenAPI and MCP schemas and the registration uniqueness and
  comparison rule;
- production JWT signing and authorization claims within the accepted token
  bound;
- shared atomic implementations for proof replay, revocation, nonce key
  rotation, token counts, recovery limits, idempotency, delivery leases,
  replies, acknowledgements, and version activation across replicas;
- trusted reverse-proxy peers and external URI reconstruction for DPoP;
- production mailbox, sender, pair, request-rate, retention, and capacity
  values;
- non-enumerating email enrollment and recovery behavior, delivery controls,
  and the atomic revoke-and-issue transaction;
- development enforcement, staging, and production rollout dates; and
- access to the production central repository or its owners for S01 through
  S07 in `docs/implementation-plan.md`.

These facts block staging and release, not fixture construction. A fixture
passing the accepted stand-in contract is evidence that the gateway and test
protocol agree. It is not evidence that the production central service does.

## Existing accepted decisions

- ADR 0006 fixes Node 24, pnpm 11.22.0 for repository work with supply-chain
  controls, TypeScript, node:test, Biome, Zod, Node HTTP, and GitHub Actions.
- ADR 0007 fixes `better-sqlite3` with no ORM for the ID-only journal.
- ADR 0012 fixes bounded, non-configurable HTTP deadlines, including a
  40-second deadline around the 30-second central long poll.
- ADR 0014 fixes a one-second SQLite singleton-lock handoff.
- ADR 0015 fixes npm-registry distribution as `@a2adev/gateway`, with end users
  running the pinned package through `npx`.
- ADR 0017 fixes the two-option foreground CLI, one webhook and identity,
  shared local bearer, and removal of bindings and runtime discovery. ADRs
  0023, 0025, and 0026 amend its central enrollment, delivery, and credential
  target without changing the gateway CLI.
- ADR 0018 fixes the official split MCP TypeScript SDK packages at version
  2.0.0.
- ADR 0019 fixes encrypted credential storage. ADR 0026 amends the stored
  plaintext to credential version 2 and permits only its exact same-key reissue
  and email-control replacement paths.
- ADR 0020 fixes the test-only Python, FastAPI, FastMCP, Pydantic, and Uvicorn
  container stack. Its 2026-08-29 amendment approves direct fixture-only use
  of the existing hash-locked `cryptography==50.0.0` wheel for P-256 and ECDSA
  operations. It does not add a gateway dependency or approve another JWT,
  JOSE, or OAuth package.
- ADR 0021 permits bounded, non-executing normalization of the development
  central MCP server's mirrored JSON or Python-literal results until native
  structured results are stable.
- ADR 0022 temporarily permits `--verbose=true` with development endpoints for
  a credential-redacted stderr transcript. Stable machine-readable central
  errors and qualified version 2 behavior are prerequisites for its removal.
