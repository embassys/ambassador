# Embassys Ambassador

Embassys Ambassador is a local bridge between an agent and the Embassys REST
service. It exposes authenticated MCP tools to the agent and delivers incoming
messages either to a webhook or directly to a local agent over ACP v1.

The accepted package and command are:

```text
@embassys/ambassador
ambassador start --local-token-env=<environment-variable>
```

Delivery is chosen through the MCP registration flow. Webhook mode sends the
complete message to a user-approved URL. Direct mode starts a gateway-managed
ACP agent session. There is no agent selector or webhook URL on `start`.

The central integration uses the unversioned REST API at
`https://mcp.embassys.ai`. Verification binds the central token to an
Ambassador-owned P-256 key. Protected requests use Bearer authorization plus a
separate DPoP proof. Ambassador does not use the central MCP endpoint.

## Implementation status

The REST and DPoP integration is implemented and live-qualified. The source
still contains the earlier webhook-only runtime and connector packages. The
approved delivery cutover, package rename, and CLI change are open work in the
[implementation plan](docs/implementation-plan.md). Do not publish a package
until that cutover and its qualification gates are complete.

## Development

Use Node.js 24 and the pnpm version recorded in `package.json`.

```text
pnpm install --frozen-lockfile
pnpm check
```

CI will use a mock webhook receiver and mock ACP v1 agent for deterministic
delivery tests. Opt-in local qualification will cover real OpenClaw and Hermes
agents in both delivery modes.

## Documentation

- [Documentation map](docs/README.md)
- [Product and architecture](docs/product-vision-and-architecture.md)
- [Target protocol](docs/protocol.md)
- [Current work](docs/implementation-plan.md)
- [Architecture decisions](docs/adr/README.md)
- [Qualification strategy](docs/qualification.md)
- [Central service follow-ups](docs/central-follow-ups.md)

## License

MIT
