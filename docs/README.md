# Documentation

## Start here

1. [Product and architecture](product-vision-and-architecture.md)
2. [Target protocol](protocol.md)
3. [Current work](implementation-plan.md)
4. [Architecture decisions](adr/README.md)
5. [Qualification strategy](qualification.md)

The architecture and protocol define the accepted target. The implementation
plan contains only work that is not complete. Until the delivery cutover lands,
the source still contains the earlier webhook-only runtime and separate
connector packages.

## Other records

| Need | Read |
| --- | --- |
| Verify the existing live REST integration | [Live central qualification](live-qualification.md) |
| Track worthwhile central service changes | [Central follow-ups](central-follow-ups.md) |
| Understand an accepted design change | [ADR ledger](adr/README.md) |

The complete central service belongs in
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). This
repository documents only Ambassador behavior that depends on it. Test fixture
details live beside the fixture code under `test/fixtures/`.

Old connector setup guides and provider-specific qualification notes describe
the implementation being removed. They are historical references, not current
instructions, and are intentionally absent from this index.

## Target repository map

| Path | Contents |
| --- | --- |
| `src/` | Ambassador CLI, local MCP, REST client, credential custody, delivery modes, and journal |
| `test/` | Unit, integration, security, artifact, and qualification tests |
| `test/fixtures/` | Independent central fixture, mock webhook receiver, and mock ACP agent |
| `docs/adr/` | Accepted decisions and the historical ledger |

The current `packages/*-connector` directories remain only until the delivery
cutover removes them.
