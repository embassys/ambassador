# Decisions to review

## 2026-08-30: Accepted CX01 Codex App Server preview contract

ADR 0034 is accepted so CX02 and CX03 can proceed without another approval
turn. The user authorized best-judgment decisions to be recorded for later
review. That review remains available and non-blocking. Acceptance is limited
to the preview implementation path and excludes publishing, stable support,
real-central compatibility claims, and Windows support.

- ADR 0034 selects exact Codex CLI and App Server version `0.149.0`. The
  inspected macOS arm64 standalone binary reports that version, and two stable
  schema generations produced the same v2 bundle SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
  The generated schema is authoritative for this pin when current web examples
  describe a later wire shape.
- Exact version stdout, canonical path, and a stable file identity do not prove
  that a same-version local binary is byte-identical to an official artifact.
  The inspected macOS arm64 digest is evidence only. The preview accepts this
  residual local-installation trust after CX04 verifies the schema digest and
  the complete real-provider behavior matrix on each claimed platform.
- The adapter uses one direct
  `codex app-server --listen stdio:// --strict-config`
  process per provider-port invocation. It enables no experimental API,
  daemon, proxy, WebSocket, socket, model override, config override, SDK, or
  new dependency. Input is one structured text item on JSONL stdin and never
  enters argv, environment, a temporary file, or connector state.
- A new `thread.id` is published before `turn/start`. The first matching
  `turn/started` notification or `turn/start` result supplies the exact turn
  handle. App Server may act before that handle arrives, so the adapter makes
  no pre-execution claim and never performs session-only recovery after an
  unbound crash.
- Exact-turn recovery uses only stable `thread/read` with
  `includeTurns: true` and the stored thread and turn IDs. It returns only an
  authoritative terminal result from that turn. Missing, running, interrupted,
  duplicate, malformed, or oversized history is uncertain and never causes a
  replacement turn.
- The first adapter sets `approvalPolicy: never`, keeps
  `approvalsReviewer: user`, and always creates or resumes a thread with coarse
  read-only access. Only `turn/start` maps the connector maximum to exact
  read-only or one-root workspace-write with network disabled. This avoids a
  thread-start project-trust write. Fake tests prove requests and observable
  responses; CX04 alone can prove real sandbox behavior and unchanged user
  configuration.
- It never accepts or grants an App Server approval. Only the three exact
  command, file-change, and permission approval request methods become a
  content-free safe wait until connector cancellation. Version 0.149.0 has no
  decision-bearing resolved notification that could safely produce
  `approval_resolved`.
- Codex owns its existing authentication and content-bearing history under the
  user's normal account home. The connector copies neither. Connector state
  retirement does not delete Codex credentials or history, and missing history
  fails closed.
- The selected hard-crash candidate is the pinned App Server's stdio lifetime:
  connector death closes its sole stdin pipe, and real qualification must prove
  that App Server and all execution descendants stop. This is an explicit
  unproven assumption, not CX01 evidence. Failure on Linux or macOS leaves that
  pair unsupported and requires a new containment decision.
- Before any terminal provider event, the adapter closes stdin and proves the
  exact App Server unit empty and the child reaped within one 3-second budget,
  invoking owned containment after 1 second when necessary. Failure emits no
  terminal provider event and follows the common containment-failure path.
- Codex is external Apache-2.0 software and is not redistributed. The official
  App Server documentation currently calls the command experimental and
  unsupported for production workloads. ADR 0034 therefore permits, at most,
  the already approved Codex-first preview after CX02 through CX04. It does not
  approve publishing, stable support, or Windows.

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
0032 permits K01 against the accepted G04 fixture contract. ADR 0034 now fixes
the Codex choices for its preview path. Claude Code and Gemini still require
separate executable or SDK, version, protocol, sandbox, approval, history,
license, and platform ADRs.

## K03 test-determinism corrections

- The K01 wake helper defaults to the injected clock's epoch when one is
  present. Explicit raw W02 timestamp vectors are unchanged. This removes a
  wall-clock dependency from deterministic connector scenarios without
  changing the webhook contract.
- Packed and clean-installed comparisons treat only pnpm's canonical
  `package.json` serialization, package-local bin shim, and missing final
  manifest LF as package-manager normalization. Parsed manifests remain
  structurally exact; every other staged payload keeps byte-hash equality,
  and every other installed path remains forbidden.
- Raw-socket setup is serialized through a recovering test-only tail and
  waits two Node event-loop turns after connect. Response collection treats
  only client `ECONNRESET` as terminal close. W08 additionally yields once
  after sending each held request head before advancing the manual clock, so
  the test observes a registered request rather than host socket scheduling.
  Production deadlines and the rejection of every other socket error are
  unchanged.
- W08 now replaces that event-loop yield with a content-free barrier on the
  injected clock: it advances only after the header timer is cleared and the
  request timer remains. This proves the held request reached `request_parsed`
  without adding a connector, CLI, staged-package, or public control surface;
  every production deadline and manual-clock value is unchanged.
- External reopened SQLite connections no longer assert `trusted_schema` or
  `max_page_count`: both are connection-local observations. The live
  connector-owned connection still proves their exact accepted values, and
  every persistent pragma, DDL, digest, mode, and row check remains exact.
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
- A03 waits until both encrypted session and turn mappings are durably visible
  before crashing, and O05 observes every exact durable retry row before it
  advances the manual clock. These are state-barrier corrections for the same
  request-observation race; no timeout, retry interval, clock value, or
  production behavior changed.
- O06 filters the proxy's raw MCP `initialize` record only when comparing the
  ordered delivery-control tool names. The proxy still retains that record,
  every defined tool remains in exact order, and separate MCP session and
  handshake evidence remains required.
- O06 treats the fixture's absent pre-ack tombstone as not acknowledged, using
  the same existing `?? false` semantic assertion as its other blocked-result
  vectors. The fake gateway continues to expose a tombstone only after exact
  acknowledgement, and later acknowledged-tombstone assertions remain exact.
- C01 now expects no provider `start` at the pre-dispatch
  `binding_published` barrier, matching C03; every post-dispatch barrier still
  requires exactly one original start. C01 and C04 observe the exact durable
  outcome-retry kind and time before advancing their manual clocks, applying
  the same ordering rule as O03 and O06 without changing the retry schedule.
- C01's committed-but-unobserved reply scenario now routes the reply through
  the existing fault proxy and drops the response after the fake gateway has
  committed it. The earlier test selected the crash seam without producing
  the uncertain transport observation the seam represents.

## CX02 test-determinism corrections

- X04 now emits `configWarning` after the fake App Server receives
  `initialized` and before the adapter sends `thread/start`. The earlier fake
  attached the warning to the `thread/start` response while also requiring
  that no `thread/start` request occur, so no implementation could satisfy
  both observations. Because JSONL `initialized` is a notification with no
  response, the adapter cannot prove that the server has finished sending
  post-initialization notifications before it writes the next request. X04
  therefore permits zero or one exact coarse read-only `thread/start` for this
  vector only. The same constraint applies to the duplicate initialize
  response written immediately after the valid response: separate stdout
  callbacks can expose that duplicate only after the client has written the
  notification and coarse request. Both vectors still require failure, no
  `thread/resume`, no `turn/start`, and no A2A input dispatch. Every
  pre-initialized invalid handshake vector retains the stricter
  no-thread-request check. The fake gives each race an optional trailing
  no-response `thread/start` exchange so it records rather than masks the
  permitted write.
- The fake App Server now handles stdin EOF independently of a blocked exchange
  tail. The earlier ordering put default EOF exit behind a gated provider
  write, so X04's manual deadline could not complete teardown without an
  unrelated test timeout killing the child. The independent EOF task still
  records stdin closure, terminates a configured descendant, emits configured
  late writes, and preserves explicit `resist` and `linger` behavior. This also
  matches X27's requirement that teardown observations remain independent of
  an in-flight provider exchange.
- X08a keeps its byte-exact outbound request assertion, then replaces only the
  cloned text item's contents with a neutral sentinel before scanning local
  setting fields. The earlier scan required the sender's literal
  `dangerFullAccess` text both present and absent in the same serialized
  request list. X09 continues to prove byte-exact input preservation.
- X09 retains the exact structured-input equality check, then replaces only
  the cloned input text with a sentinel and recursively inspects every other
  request, argument, and environment string. The earlier `JSON.stringify`
  substring count could not find a sender newline because JSON must escape it,
  even though the structured value was preserved. The recursive leaf check
  proves that input is absent from every other carrier without depending on
  JSON escaping.
- X06 uses the existing `session_binding` recovery crash seam for the
  post-session-publication case. The earlier `binding_published` seam runs
  before the provider-port call and therefore cannot observe the one
  `thread/start` required by X06. This retains one thread start, no turn start,
  and null-turn uncertainty after restart, and matches the recorded K03/K04
  barrier ordering.
- The CX02 adapter factory now preserves an explicit null fixture executable
  while it still defaults an omitted value to the fake executable. The earlier
  nullish-coalescing expression replaced null with the fake path, so X01's
  no-executable case launched a valid fake process instead of exercising the
  reviewed unavailable-adapter path.

## K03 implementation judgments

- The local gateway client uses the approved
  `@modelcontextprotocol/client` 2.0.0 `StreamableHTTPClientTransport`, pins
  the accepted 2025-06-18 handshake, sends `notifications/initialized`, and
  applies the injected 35-second request abort. A project-owned fetch wrapper
  keeps redirects manual, bounds collected response bytes to 4 MiB, and
  rejects a JSON-RPC response whose ID does not match the request. This is a
  boundary hardening layer around the approved transport, not a second MCP
  implementation.
- Startup acquires the SQLite owner singleton before schema inspection on the
  pre-token path, so a live owner yields `connector_already_running` within
  the fixed busy timeout instead of blocking on schema reads. Normal state
  opening retains the full schema and pragma validation. Failed opens erase
  derived keys and close both database handles.
- After an uncertain reply transport result, the connector discards the
  in-memory reply bytes and relies only on central outcome lookup plus the
  exact provider-turn recovery contract. It never persists or reconstructs
  reply text from correlation state.
- K03's process environment, output-boundary, cancellation, and containment
  helpers are provider-neutral foundation evidence only. Each real provider
  ADR and adapter must attach those helpers to its actual launch path and pass
  provider/platform containment qualification before that adapter is
  supported.
- The user approved a Codex-first usable preview after K03 and K04. Claude
  Code and Gemini follow as parallel adapter tracks. Real-central
  qualification, publication, soak evidence, and stable support claims remain
  deferred to their existing later gates.

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

- K04 uses one test-only connector child entrypoint under `test/support`. It is
  absent from package bins and exports, accepts only a closed fake-provider
  plan, and exchanges content-free process-control events. The normal test
  runner excludes both fixed-port K04 files from its parallel set, requires
  their exact inventory, and runs them together with concurrency one after the
  parallel child has closed.
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
- ADR 0034 now fixes those choices for the Codex preview path. Claude Code and
  Gemini still need exact executable or SDK versions, protocol schemas,
  dependency decisions, sandbox and approval policies, history behavior,
  supported platforms, and update policies.
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
