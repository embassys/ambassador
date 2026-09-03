# Embassys Ambassador

Embassys Ambassador is a local bridge between an agent and the Embassys REST
service. Agents call it through MCP. Incoming messages go directly to a local
agent over ACP v1 or to an authenticated webhook.

## Start

```sh
npx --yes @embassys/ambassador@latest start
```

- No Ambassador token or environment variable is needed for direct delivery.
- Configure your agent's MCP client for `http://127.0.0.1:8787/mcp` without
  authentication.
- Ask the agent to register your email with Ambassador.
- OpenClaw and Hermes users choose **direct** (the default) or **webhook**.
  Codex and Claude Code proceed directly without a delivery question.
- Webhook users run
  `npx --yes @embassys/ambassador@latest webhook-secret`, copy the displayed
  value into Hermes's owner-only receiver configuration or OpenClaw's
  owner-only hooks configuration, and give the agent only the receiver URL
  during registration.

Direct delivery supports OpenClaw, Hermes, Codex, and Claude Code.
Webhook delivery supports OpenClaw and Hermes. Unknown or incomplete profiles
fail closed. The agent cannot choose an executable, adapter, or arbitrary
delivery implementation. Ambassador matches exact known MCP client and ACP
agent names, but treats their reported versions as diagnostic metadata. It
tries the fixed ACP v1 contract and reports an actual incompatibility at
startup, initialization, session creation, or delivery.

The central integration uses the unversioned REST API at
`https://mcp.embassys.ai`. Verification binds the central token to an
Ambassador-owned P-256 key. Protected requests use Bearer authorization plus a
separate DPoP proof. Ambassador does not use the central MCP endpoint.

## Repeat a local registration test

Stop the foreground Ambassador process, then reset local Ambassador state:

```sh
npx --yes @embassys/ambassador@latest clean
```

The command removes the local registration, encrypted credentials, delivery
profile, webhook secret, notification journal, and interrupted state writes. It
keeps only the empty owner-only state directory and singleton lock needed to
prevent cleanup while Ambassador is running.

For a manual reset, move the entire local Ambassador state directory to Trash
or to an owner-only backup after stopping Ambassador:

- macOS: `~/Library/Application Support/ambassador`
- Linux: `$XDG_STATE_HOME/ambassador`, or `~/.local/state/ambassador` when
  `XDG_STATE_HOME` is unset
- Windows: `%LOCALAPPDATA%\ambassador`

Remove the directory as one unit. Deleting only `delivery-profile.json`, an
encrypted value, or its key leaves an intentionally invalid partial state. The
next `ambassador start` presents the enrollment tools again. Neither reset
method deletes the central registration, so use a new disposable email when
rerunning without server-side cleanup. Neither changes the agent's normal
provider configuration or credentials.

## Implementation status

The REST, DPoP, delivery, internal webhook-secret, and zero-configuration
startup paths are implemented. Live-central qualification has passed with
real Codex and Claude Code, and with Hermes Agent 0.20.5 and OpenClaw 2026.8.2
in both delivery modes. Ambassador matches exact known client and ACP agent
names while treating reported versions as observations. Gemini CLI and
Antigravity are not active profiles; [ADR 0043](docs/adr/0043-remove-gemini-and-defer-antigravity.md)
records that decision.

Published Ambassador releases through 0.2.9 have no Windows support claim.
Published Ambassador 0.2.12 is qualified under
[ADR 0040](docs/adr/0040-windows-qualification.md). Its native state,
packed-package, local-cleanup, and mock delivery lanes pass on Windows.
Individual agent and mode claims still require exact real-agent Windows
evidence.

## Development

Use Node.js 24 and the pnpm version recorded in `package.json`.

```text
pnpm install --frozen-lockfile
pnpm check
```

CI uses a mock webhook receiver and mock ACP v1 agent for deterministic
delivery tests. Opt-in local qualification covers direct delivery for all four
supported agents and webhook delivery for OpenClaw and Hermes.

## Documentation

- [Documentation map](docs/README.md)
- [Product and architecture](docs/product-vision-and-architecture.md)
- [Target protocol](docs/protocol.md)
- [Current work](docs/implementation-plan.md)
- [Architecture decisions](docs/adr/README.md)
- [Qualification strategy](docs/qualification.md)
- [Codex setup](docs/getting-started-codex.md)
- [Claude Code setup](docs/getting-started-claude.md)
- [Hermes setup](docs/getting-started-hermes.md)
- [OpenClaw setup](docs/getting-started-openclaw.md)
- [Reset local test state](docs/development-reset.md)
- [Central service follow-ups](docs/central-follow-ups.md)

## License

MIT
