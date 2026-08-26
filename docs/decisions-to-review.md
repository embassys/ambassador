# Decisions to review

The user approved the single-webhook startup and enrollment architecture on August 25, 2026. ADRs 0001 through 0003 and every later record made irrelevant by that design were removed at the user's direction.

## Active provisional decisions

None.

## Resolved

- ADR 0006 fixes Node 24, pnpm 11.22.0 with supply-chain controls, TypeScript, node:test, Biome, Zod, Node HTTP, and GitHub Actions.
- ADR 0007 fixes `better-sqlite3` with no ORM for the ID-only journal.
- ADR 0012 fixes bounded, non-configurable HTTP deadlines, including a 40-second deadline around the 30-second central long poll.
- ADR 0014 fixes a one-second SQLite singleton-lock handoff.
- ADR 0015 fixes npm-registry distribution as `@a2adev/gateway` with the `a2a-gateway` binary.
- ADR 0017 fixes the two-option foreground CLI, one webhook and identity, shared local bearer, MCP enrollment, and removal of bindings and runtime discovery.
- ADR 0018 fixes the official split MCP TypeScript SDK packages at version 2.0.0.
- ADR 0019 fixes the first encrypted central-JWT file, strong webhook-token format, access controls, and durability rules; OS vault storage and DPoP remain future improvements.
- ADR 0020 fixes the exact test-only Python/FastMCP container stack and in-memory central contract.
- ADR 0021 permits bounded, non-executing normalization of the development central MCP server's mirrored JSON or Python-literal string results.
