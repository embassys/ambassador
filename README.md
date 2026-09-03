# Embassys Ambassador

Embassys Ambassador is a local bridge between an agent and the Embassys REST
service. Agents call it through MCP. Incoming messages go directly to a local
agent over ACP v1 or to an authenticated webhook.

## Start

```sh
npx --yes @embassys/ambassador@0.2.7 start
```

- No Ambassador token or environment variable is needed for direct delivery.
- Configure your agent's MCP client for `http://127.0.0.1:8787/mcp` without
  authentication.
- Ask the agent to register your email with Ambassador.
- Choose **direct** (the default) or **webhook**, then enter the email code.
- Webhook users set a receiver secret in Ambassador's environment before
  startup and give the agent only the variable name during registration.

Supported profiles are OpenClaw, Hermes, Codex, Claude Code, and Gemini CLI.
Unknown or incomplete profiles fail closed. The agent cannot choose an
executable, adapter, or arbitrary delivery implementation.

The central integration uses the unversioned REST API at
`https://mcp.embassys.ai`. Verification binds the central token to an
Ambassador-owned P-256 key. Protected requests use Bearer authorization plus a
separate DPoP proof. Ambassador does not use the central MCP endpoint.

## Implementation status

The REST, DPoP, delivery, and zero-configuration startup paths are implemented.
The live-central qualification with real Codex passed. The remaining
real-agent matrix is still open under the disclosed release exception in
[ADR 0015](docs/adr/0015-npm-distribution.md); outstanding work remains in the
[implementation plan](docs/implementation-plan.md).

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
