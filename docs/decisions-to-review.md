# Decisions to review

The user approved the single-webhook startup and enrollment architecture on August 25, 2026. ADRs 0001 through 0003 and every later record made irrelevant by that design were removed at the user's direction.

## Active provisional decisions

| ADR | Decision | Review before |
| --- | --- | --- |
| `0006-toolchain.md` | Node 24, npm, TypeScript, node:test, Biome, Zod, Node HTTP, and GitHub Actions | Changing the existing toolchain |
| `0007-sqlite.md` | better-sqlite3 with no ORM for the ID-only journal | Changing durable relay storage |
| `0012-http-deadlines.md` | Bounded HTTP operations and redirect rejection | Public beta operating defaults |
| `0014-lock-handoff-timeout.md` | One-second SQLite singleton-lock handoff | Public beta operating defaults |

## Approval required

| ADR | Recommendation | Needed before |
| --- | --- | --- |
| `0018-mcp-sdk.md` | Official split MCP TypeScript SDK version 2 packages | Installing production MCP dependencies |
| `0019-central-credential-storage.md` | AES-256-GCM credential file keyed from the webhook token | Implementing durable central JWT storage |

## Resolved

- ADR 0015 fixes npm distribution as `@a2adev/gateway` with the `a2a-gateway` binary.
- ADR 0017 fixes the two-option foreground CLI, one webhook and identity, shared local bearer, MCP enrollment, and removal of bindings and runtime discovery.
- ADR 0020 fixes the exact test-only Python/FastMCP container stack and in-memory central contract.
