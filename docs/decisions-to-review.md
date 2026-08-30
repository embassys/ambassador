# Decisions to review

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
  central-owner review are still required before production gateway work
  begins.
- ADR 0024 accepts separate foreground provider connectors while the gateway
  and its CLI remain unchanged. One gateway, connector, and provider form one
  pair. The connector receives the loopback webhook wake, retrieves content
  through the local gateway MCP endpoint, and owns content-free correlation
  state. The central credential remains in the gateway, provider credentials
  remain in the provider runtime, and the connector never blindly replays an
  uncertain provider turn.
- This boundary approval does not complete D05. Concrete connector CLI, state,
  cryptography, limits, dependencies, provider interfaces, approval policy,
  packaging, installation, platform, and publishing decisions remain pending.

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

- D05 remains pending after ADR 0024's boundary approval. The connector
  executable and CLI or configuration interface, working directory, security
  policy, state technology and schema, access controls, encryption,
  fresh-install behavior, deletion, runtime, dependencies, provider
  interfaces, limits, concurrency, timeouts, and approval behavior remain
  undecided.
- Each Codex, Claude Code, and Gemini adapter still needs its own exact
  executable or SDK version, protocol schema, dependency decision, sandbox and
  approval policy, history behavior, supported platforms, and update policy.
- Connector installation, packaging, publishing, and distribution remain
  unapproved. The gateway CLI stays unchanged.
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
