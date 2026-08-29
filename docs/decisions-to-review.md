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
