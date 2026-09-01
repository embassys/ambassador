# Project wiki

Status: current documentation map as of 2026-09-01

## Start here

Read these documents before implementation work:

1. [Product vision and architecture](product-vision-and-architecture.md)
2. [Gateway protocol](protocol-v1.md)
3. [Implementation plan](implementation-plan.md)
4. [Decisions to review](decisions-to-review.md)
5. [ADR 0037: live central REST contract](adr/0037-live-central-rest-contract.md)

The [architecture overview](architecture-overview.md) is the shorter human
summary. The [human work queue](human-work.md) shows what remains.

## Current baseline

There is one development target. The gateway will integrate with the current
unversioned REST API at `https://mcp.embassys.ai` using the DPoP behavior in
`embassys/agent2agent` commit
`b769896b7cfb1ee3540195be9e7a61cf777b9388`.

The gateway does not use the central MCP endpoint. Protected REST requests use
`Authorization: Bearer <token>` plus a separate `DPoP` proof header. The
gateway does not support the older bearer-only client, the earlier central MCP
fallback, or the repository's speculative `/api/v2` design. This is a fresh
development cutover with no migration path.

The current repository code still contains parts of those superseded designs.
The next implementation work replaces them test-first. Do not use the
published `0.2.6` package as evidence of current central compatibility.

Live registration, verification, DPoP binding, missing-proof rejection,
wrong-key rejection, replay rejection, generated OpenAPI, and the six-action
catalog have been observed. The remaining live work is the full two-identity
permission and action flow through the rebuilt gateway.

## Documentation map

| Need | Read |
| --- | --- |
| Understand the system | [Architecture overview](architecture-overview.md) |
| Check exact gateway behavior | [Gateway protocol](protocol-v1.md) |
| Check the source-derived central API | [Central REST contract inventory](central-server-implementation-spec.md) |
| Check live observations and remaining E2E work | [Server integration status](server-integration-status.md) |
| Check implementation order | [Implementation plan](implementation-plan.md) |
| See planned PR boundaries | [Architecture PR backlog](architecture-pr-backlog.md) |
| Check current human work | [Human work queue](human-work.md) |
| Check architecture decisions | [ADR index](adr/README.md) |
| Check the replacement fixture target | [Central fixture profile](central-fixture-profile.md) |
| Check nonblocking central improvements | [Central follow-ups](central-interface-change-requests.md) |
| Operate an unreleased connector | [Connector setup and retention](connector-setup-and-retention.md) |

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Gateway CLI, local MCP server, central REST clients, credential custody, relay, and journal |
| `packages/connector-core/` | Provider-neutral webhook and provider process foundation |
| `packages/codex-connector/` | Codex adapter |
| `packages/claude-connector/` | Claude Code adapter |
| `packages/gemini-connector/` | Command shell only; no approved adapter |
| `test/` | Gateway, connector, provider, package, security, and artifact tests |
| `test/fixtures/` | Independent central fixture and frozen provider schemas |
| `docs/adr/` | Accepted, rejected, amended, and superseded decisions |

## Authority

- ADR 0037 and the protocol own the current central integration contract.
- The source inventory records what the pinned central implementation does.
- The implementation plan owns task order and evidence.
- Old ADRs remain as history. A superseded ADR is not a current requirement.
- Fixture behavior never overrides the pinned source or live observations.
