# Embassys Ambassador

Embassys Ambassador is a local bridge between an agent and the Embassys REST
service. It exposes authenticated MCP tools to the agent and delivers incoming
messages either to a webhook or directly to a local agent over ACP v1.

The accepted package and command are:

```text
@embassys/ambassador
ambassador start --local-token-env=<environment-variable>
```

Delivery is resolved through the MCP registration flow and a fixed capability
registry. OpenClaw, Hermes, Codex, Claude Code, and Gemini CLI support both
modes, so Ambassador asks their users to choose direct or webhook and presents
direct as the default. Codex uses the existing
`@agentclientprotocol/codex-acp` adapter, Claude Code uses
`@agentclientprotocol/claude-agent-acp`, and Gemini CLI uses native ACP. A known
direct-only profile would proceed without a delivery question. Unknown or
incomplete profiles are rejected; the model cannot select an agent, command,
or adapter. Webhook mode sends the complete message to a user-approved URL.
Direct mode starts a gateway-managed ACP agent session. There is no agent
selector or webhook URL on `start`.

The central integration uses the unversioned REST API at
`https://mcp.embassys.ai`. Verification binds the central token to an
Ambassador-owned P-256 key. Protected requests use Bearer authorization plus a
separate DPoP proof. Ambassador does not use the central MCP endpoint.

## Implementation status

The REST and DPoP integration and deterministic Ambassador delivery cutover
are implemented. The live-central qualification with real Codex passed. The
user approved publication of `@embassys/ambassador@0.2.6` before the remaining
real-agent matrix is complete. That one-release exception is recorded in
[ADR 0015](docs/adr/0015-npm-distribution.md); the outstanding qualification
work remains visible in the [implementation plan](docs/implementation-plan.md).

## Development

Use Node.js 24 and the pnpm version recorded in `package.json`.

```text
pnpm install --frozen-lockfile
pnpm check
```

CI uses a mock webhook receiver and mock ACP v1 agent for deterministic
delivery tests. Opt-in local qualification covers all five supported agents in
both delivery modes.

## Documentation

- [Documentation map](docs/README.md)
- [Product and architecture](docs/product-vision-and-architecture.md)
- [Target protocol](docs/protocol.md)
- [Current work](docs/implementation-plan.md)
- [Architecture decisions](docs/adr/README.md)
- [Qualification strategy](docs/qualification.md)
- [Codex setup](docs/getting-started-codex.md)
- [Claude Code setup](docs/getting-started-claude.md)
- [Gemini CLI setup](docs/getting-started-gemini.md)
- [Hermes setup](docs/getting-started-hermes.md)
- [OpenClaw setup](docs/getting-started-openclaw.md)
- [Central service follow-ups](docs/central-follow-ups.md)

## License

MIT
