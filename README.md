# A2A Gateway

A local gateway that exposes an authenticated loopback MCP endpoint and relays
Embassys REST messages to one configured webhook.

## Current status

The project is being switched to the live unversioned REST API at
`https://mcp.embassys.ai`. The current contract uses email-only registration,
a P-256 JWK in the verification request, and protected requests with:

```http
Authorization: Bearer <DPoP-bound-token>
DPoP: <proof-jwt>
```

The gateway does not use the central MCP endpoint. It does not support the old
bearer-only/MCP client, the repository's proposed `/api/v2` client, or state
migration.

The published `0.2.6` package predates this decision and is not supported
against the current DPoP REST contract. Do not use it for a new setup. A new
package will be considered after the replacement tests, implementation, and
live two-identity E2E pass.

## Product boundary

The eventual command remains:

```text
a2a-gateway start --webhook-url=<loopback-url> --webhook-token-env=<name>
```

One foreground process owns one webhook target and one central identity. The
same local secret authenticates the webhook and the loopback MCP endpoint at
`http://127.0.0.1:8787/mcp`.

The gateway keeps the central token and DPoP private key in one encrypted
credential file. Message bodies remain in bounded memory. SQLite stores only
opaque message IDs and relay state.

The current central server consumes messages when polling returns them and
does not redeliver delivered messages. A gateway crash can lose an in-memory
message. This is an explicit development limitation.

## Development

Use Node.js 24 and the exact pnpm version recorded in `package.json`.

```text
pnpm install --frozen-lockfile
pnpm check
```

The existing suite still contains tests for superseded central contracts. See
the [implementation plan](docs/implementation-plan.md) before treating a green
run as current live compatibility.

## Documentation

- [Project wiki](docs/README.md)
- [Architecture overview](docs/architecture-overview.md)
- [Gateway protocol](docs/protocol-v1.md)
- [Current central contract inventory](docs/central-server-implementation-spec.md)
- [Server integration status](docs/server-integration-status.md)
- [Implementation plan](docs/implementation-plan.md)
- [ADR 0037](docs/adr/0037-live-central-rest-contract.md)

## License

MIT
