# Decisions to review

The user approved the single-webhook startup and enrollment architecture on August 25, 2026. ADRs 0001 through 0003 and every later record made irrelevant by that design were removed at the user's direction.

## Active provisional decisions

- ADR 0023 proposes replacing central MCP bootstrap forwarding with bounded REST
  calls for registration, verification, and resend. It remains blocked on the
  canonical registration path, an HTTPS endpoint, complete response and error
  semantics, and user approval. The supplied `/api/register` path conflicts with
  the live OpenAPI document's `/api/register_agent` path.
- ADR 0024 proposes separate loopback provider connectors for persistent Codex,
  Claude Code, and Gemini CLI sessions. The gateway remains provider-neutral
  and stores no provider session mapping. Connector state, startup,
  dependencies, security policy, installation, and publishing still need
  separate approval.
- ADR 0025 proposes stable central conversation IDs, recoverable unacknowledged
  delivery, and an idempotent reply operation tied to the original inbound
  message. The live OpenAPI document does not advertise those contracts, so
  central definitions and user approval block connector implementation.
- ADR 0026 proposes binding newly issued central JWTs to a gateway-held P-256
  key with RFC 9449 DPoP. It requires issuer and resource-server enforcement,
  transport-level DPoP on REST and central MCP, removal of MCP `token`
  arguments, a version 2 encrypted credential, replay and nonce state, and a
  reviewed migration path for existing bearer JWTs.

## Proposed defaults awaiting review

These are working decisions, not accepted architecture. They give contract and
red-test work one deterministic target while leaving production implementation
blocked on review.

### Enrollment and recovery

- Prefer the newest supplied `POST /api/register` contract. Do not probe
  `/api/register_agent`, retry on a second path, or fall back to MCP.
- Keep the three bootstrap routes unversioned, use a fixed product HTTPS origin,
  and allow plain HTTP only for an explicit loopback fixture.
- Apply a 30-second total deadline, 16 KiB response-header limit, 64 KiB
  response-body limit, strict JSON parsing, fixed safe errors, and no automatic
  retry after an uncertain enrollment outcome.
- Make resend non-enumerating. If DPoP is accepted, a separately authorized
  recovery state may use a fresh email-control code for an already-verified
  identity; normal enrollment still cannot replace an identity.
- Same-key token reissue is routine renewal only. A lost initial issuance,
  missing private key, version 1 credential, or deliberate key rotation requires
  email-control recovery and same-identity validation.

### Messages and conversations

- Use central database leases, initially 60 seconds, to redeliver immutable
  unacknowledged messages. Gateway and connector durable state stays
  content-free.
- Use a strict, text-only, linear conversation model with server-generated
  conversation IDs and at most one reply to each turn.
- Use REST as the gateway's fixed version 2 message-lifecycle interface. Do not
  probe or fall back to central MCP. Keep the authenticated MCP endpoint stable
  at `/mcp`; version 2 is selected by a coordinated release and atomic
  per-identity activation, not runtime discovery.
- Derive reply routing and idempotency from the authenticated recipient and
  inbound message ID. Keep terminal completion separate from idempotent
  acknowledgement, and retain content-free tombstones.
- Require central recipient authorization or consent plus per-sender abuse
  controls before starting a conversation. Unknown and unauthorized targets
  must not become an identity oracle.
- Select receive batches by both count and serialized byte budget. Provide a
  content-free outcome lookup for uncertain conversation creation and notify or
  otherwise make senders poll when a turn ends without a reply.

### DPoP and credential lifecycle

- Pin ES256 with P-256, exact JOSE and JWK shapes, a 60-second maximum proof
  age, 5 seconds of future skew, shared replay rejection, and mandatory bounded
  server nonces. Do not negotiate algorithms at runtime.
- Issue 24-hour DPoP-bound JWTs, begin same-key reissue with 12 hours remaining,
  and never accept a DPoP-bound token through a bearer path.
- Authenticate every protected REST and central MCP HTTP request with
  `Authorization: DPoP` and a fresh proof. Remove credentials from MCP tool
  arguments and results.
- Store the access token and P-256 private key together in the version 2
  encrypted credential. Replacement must be atomic and must preserve the exact
  issuer, subject, audiences, key binding, algorithm, and lifetime contract.
- Use email-control re-verification for recovery, key rotation, and legacy
  bearer migration. Never permit bearer-only key rebinding.
- Treat transport DPoP on central MCP as a project-specific profile. A future
  move to the standard MCP OAuth authorization model is a separate decision.

## Facts required before approval

- Central must publish the canonical HTTPS issuer, API, and stable MCP URLs and
  confirm the deployed registration, verification, resend, recovery, revocation,
  message, success, and error schemas.
- Central must confirm verification-code syntax, token signing and authorization
  claims, rate limits, mailbox quotas, retention, recipient-consent policy, and
  the shared database transactions used for leases, idempotency, replay, nonce,
  revocation, and recovery state across replicas.
- Deployment owners must confirm trusted proxy peers and external URI
  reconstruction for DPoP, plus migration and legacy-bearer retirement dates.
- The gateway still needs a reviewed local interface for intentional identity
  reset and unreadable-credential recovery.
- ADR 0024 still needs provider command, event, sandbox, approval, retention,
  dependency, installation, publishing, and supported-platform decisions for
  Codex, Claude Code, and Gemini CLI.

## Resolved

- ADR 0006 fixes Node 24, pnpm 11.22.0 for repository work with supply-chain controls, TypeScript, node:test, Biome, Zod, Node HTTP, and GitHub Actions.
- ADR 0007 fixes `better-sqlite3` with no ORM for the ID-only journal.
- ADR 0012 fixes bounded, non-configurable HTTP deadlines, including a 40-second deadline around the 30-second central long poll.
- ADR 0014 fixes a one-second SQLite singleton-lock handoff.
- ADR 0015 fixes npm-registry distribution as `@a2adev/gateway`, with end users running the pinned package through `npx`.
- ADR 0017 fixes the two-option foreground CLI, one webhook and identity, shared local bearer, MCP enrollment, and removal of bindings and runtime discovery.
- ADR 0018 fixes the official split MCP TypeScript SDK packages at version 2.0.0.
- ADR 0019 fixes the first encrypted central-JWT file, strong webhook-token format, access controls, and durability rules; OS vault storage and DPoP remain future improvements.
- ADR 0020 fixes the exact test-only Python/FastMCP container stack and in-memory central contract.
- ADR 0021 permits bounded, non-executing normalization of the development central MCP server's mirrored JSON or Python-literal string results.
- ADR 0022 temporarily permits `--verbose=true` with development endpoints so live MCP and polling failures can be diagnosed from a credential-redacted stderr transcript. A TODO requires its removal.
