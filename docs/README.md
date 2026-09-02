# Documentation

## Start here

1. [Product and architecture](product-vision-and-architecture.md)
2. [Gateway protocol](protocol.md)
3. [Current work](implementation-plan.md)
4. [Architecture decisions](adr/README.md)

The architecture explains why the gateway has its current boundaries. The
protocol defines exact behavior. The implementation plan contains only work
that has not been completed.

## Guides and records

| Need | Read |
| --- | --- |
| Run the live integration checks | [Live qualification](live-qualification.md) |
| Track worthwhile central service changes | [Central follow-ups](central-follow-ups.md) |
| Prepare an OpenClaw setup | [OpenClaw guide](getting-started-openclaw.md) |
| Prepare a Hermes setup | [Hermes guide](getting-started-hermes.md) |
| Work on provider connectors | [Connector setup and retention](connector-setup-and-retention.md) |
| Qualify the Codex adapter | [Codex qualification](cx04-codex-manual-qualification.md) |
| Qualify the Claude adapter | [Claude qualification](cl04-claude-code-manual-qualification.md) |

The complete central service belongs in
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). This
repository documents only the gateway behavior that depends on it. Test
fixture details live beside the fixture code under `test/fixtures/`.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Gateway CLI, local MCP server, REST client, credential custody, relay, and journal |
| `packages/connector-core/` | Provider-neutral webhook and provider process foundation |
| `packages/codex-connector/` | Codex adapter |
| `packages/claude-connector/` | Claude Code adapter |
| `packages/gemini-connector/` | Command shell only; no approved adapter |
| `test/` | Gateway, connector, package, security, and artifact tests |
| `test/fixtures/` | Independent central fixture and frozen provider schemas |
| `docs/adr/` | Current architecture decisions |
