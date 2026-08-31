# Project wiki

Status: documentation entry point as of 2026-08-31

This page is the map for humans and coding agents. It does not replace the
protocol, ADRs, or test inventories. Each fact should have one authoritative
home, with the other pages linking to it.

## Start here

For a five-minute human read:

1. Read the [architecture overview](architecture-overview.md).
2. Check the [human work queue](human-work.md).
3. Use the root [README](../README.md) for the shipped `0.2.6` development
   flow.

For any implementation task, follow the mandatory order in
[AGENTS.md](../AGENTS.md):

1. [Product vision and architecture](product-vision-and-architecture.md)
2. [Protocol](protocol-v1.md)
3. [Implementation plan](implementation-plan.md)
4. [Decisions to review](decisions-to-review.md)
5. The relevant accepted records in the [ADR index](adr/README.md)

The [architecture overview](architecture-overview.md) explains the system but
is not a shortcut around that reading order.

## Current reality

The repository contains two deliberately separate product states:

- `0.2.6` is the shipped compatibility gateway. It uses the live central
  service's current bearer and consuming-poll behavior.
- The accepted version 2 gateway, connector foundation, Codex adapter, and
  Claude adapter are implemented and tested against local fixtures. They are
  not a production release. Real central qualification and real provider
  qualification have not completed.

The central server repository is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). The project
owner reports that DPoP has been implemented, but the exact DPoP source
revision and deployment have not been pinned. The inspected default branch and
hosted routes still expose the older bearer API. See the
[server integration status](server-integration-status.md) for the evidence and
the I01 complete-API re-baseline and I02 contact-template DPoP E2E tasks.

Gemini has no selected adapter. ADR 0036 rejected the reviewed Gemini CLI
interface. Windows is outside the initial release under ADR 0033.

The [human work queue](human-work.md) is the short status view. The
[architecture PR backlog](architecture-pr-backlog.md) owns the full dependency
graph and completion evidence.

## Documentation map

| Need | Read | Authority |
| --- | --- | --- |
| Understand the system quickly | [Architecture overview](architecture-overview.md) | Summary only |
| See human decisions, reviews, and remaining work | [Human work queue](human-work.md) | Current action view |
| Understand the product boundary | [Product vision and architecture](product-vision-and-architecture.md) | Product authority |
| Check exact gateway behavior | [Protocol](protocol-v1.md) | Protocol authority |
| Check task order and gates | [Implementation plan](implementation-plan.md) and [architecture PR backlog](architecture-pr-backlog.md) | Planning authority |
| Check accepted design choices | [ADR index](adr/README.md) | Decision authority |
| Review delegated implementation choices | [Decisions to review](decisions-to-review.md) | Review record |
| Inspect the central team's contract | [Central implementation specification](central-server-implementation-spec.md) | External handoff specification |
| Check the server source, deployment drift, and live integration tasks | [Server integration status](server-integration-status.md) | Dated evidence and action view |
| Inspect test-only central values | [Version 2 fixture profile](v2-fixture-profile.md) | Test-only authority |
| Operate an unreleased connector | [Connector setup and retention](connector-setup-and-retention.md) | Prepared operator guide, not a support claim |
| Run real Codex qualification | [Codex manual qualification](cx04-codex-manual-qualification.md) | Manual evidence procedure |
| Run real Claude qualification | [Claude manual qualification](cl04-claude-code-manual-qualification.md) | Manual evidence procedure |
| Inspect exact negative cases | `test/*-failure-inventory.md` | Reviewed test inventory |

The [implementation status](implementation-status.md) page is a historical
snapshot of the shipped compatibility work. Do not use it as the current
version 2 status page.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Gateway CLI, local MCP server, enrollment, DPoP transport, credential custody, message lifecycle, relay, and journal |
| `packages/connector-core/` | Provider-neutral webhook, local MCP client, encrypted correlation state, execution state machine, and connector CLI |
| `packages/codex-connector/` | Codex App Server adapter and command |
| `packages/claude-connector/` | Claude Code adapter, lifetime monitor, and command |
| `packages/gemini-connector/` | Command shell only; no approved provider adapter |
| `test/` | Gateway, connector, provider, package, crash, security, and artifact tests |
| `test/support/` | Fake central, fake gateway, fake providers, process harnesses, and deterministic fault controls |
| `test/fixtures/` | Independent Python central fixture and frozen provider schemas |
| `scripts/` | Build, package, inventory, artifact scan, and manual qualification runners |
| `docs/adr/` | Accepted, rejected, and superseded design records |

## Reading paths by task

Gateway work:

1. Product vision and protocol
2. ADRs 0017, 0019, and 0023 through 0027
3. T03 and T04 failure inventories
4. Relevant files under `src/`

Connector foundation work:

1. Architecture overview
2. ADRs 0024 and 0028 through 0031
3. K02 failure inventory and K04 system tests
4. Relevant files under `packages/connector-core/`

Provider adapter work:

1. Connector foundation reading path
2. ADR 0034 for Codex, ADR 0035 for Claude, or ADR 0036 before any new Gemini proposal
3. The provider failure inventory and manual qualification guide
4. The matching provider package

Release work:

1. Human work queue
2. Server integration status
3. Architecture PR backlog wave 8
4. ADRs 0015, 0031, 0032, and 0033
5. Real central and real provider evidence

## Maintenance rules

- Keep this page navigational. Put protocol detail in the protocol or an ADR.
- Update the architecture overview when a component, trust boundary, or
  lifecycle changes.
- Update the human work queue when a gate closes, a review is accepted, or a
  new blocker appears.
- Give status pages an explicit date and distinguish shipped behavior from the
  accepted target.
- Link to test inventories instead of copying their full edge-case lists.
- Do not turn fixture success into a production central or provider claim.
- Preserve accepted ADRs. Add a superseding record when a decision changes.
