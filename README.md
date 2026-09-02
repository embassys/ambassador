# A2A Gateway

A local gateway that exposes an authenticated loopback MCP endpoint and relays
Embassys messages to one configured webhook.

## What it does

The gateway integrates with the current Embassys REST service at
`https://mcp.embassys.ai`. Registration is email-based. Verification binds the
central token to a gateway-owned P-256 key. Protected requests send the token
as Bearer authorization and carry a separate DPoP proof.

The gateway does not use the central MCP endpoint. It has no API-version
selector, legacy central client, or state migration path.

The public command is:

```text
a2a-gateway start --webhook-url=<loopback-url> --webhook-token-env=<name>
```

One foreground process owns one webhook target and one central identity. The
same local secret authenticates the webhook and the loopback MCP endpoint at
`http://127.0.0.1:8787/mcp`.

The central token and DPoP private key live in one encrypted credential file.
Message bodies stay in bounded memory. SQLite stores only opaque message IDs
and relay state.

The current server consumes messages when polling returns them and cannot
redeliver them. A gateway crash can therefore lose an in-memory message. This
is a known development limitation.

The central service source is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). The gateway
tracks that service as it changes. Client, fixture, protocol, and live
qualification updates should land together when its contract changes.

## Development

Use Node.js 24 and the pnpm version recorded in `package.json`.

```text
pnpm install --frozen-lockfile
pnpm check
```

The test suite includes a fast Node fixture and an independent Python fixture.
The live qualification procedure covers registration, DPoP, permissions,
action delivery, polling, acknowledgement, restart behavior, and artifact
scans.

The published `0.2.6` package predates the current REST integration. A new
publication requires separate approval.

## Documentation

- [Documentation map](docs/README.md)
- [Product and architecture](docs/product-vision-and-architecture.md)
- [Gateway protocol](docs/protocol.md)
- [Current work](docs/implementation-plan.md)
- [Architecture decisions](docs/adr/README.md)
- [Live qualification](docs/live-qualification.md)
- [Central service follow-ups](docs/central-follow-ups.md)

## License

MIT
