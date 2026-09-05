# Embassys Ambassador

Embassys Ambassador is a local bridge between an agent and the Embassys REST
service. Agents call it through MCP. Incoming messages go directly to a local
agent over ACP v1 or to an authenticated webhook.

## Start

- Install Node.js 24.19.0 or newer and sign in to a supported local agent.
- From the directory the agent may access, run:

```sh
npx --yes @embassys/ambassador@latest start
```

- Keep that process open. It prints the MCP endpoint, diagnostic-log directory,
  and setup commands for Codex, Claude Code, Hermes, and OpenClaw.
- Add `http://127.0.0.1:8787/mcp` to the agent as a token-free Streamable HTTP
  MCP server. Follow the linked agent guide below for its command or UI steps.
- Restart or reload the agent, then say: **Register me with Embassys using
  me@example.com.**
- Give the agent the six-digit code sent to that address.
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
delivery implementation. Ambassador includes the approved Codex and Claude
Code ACP adapters; users do not install them separately. OpenClaw and Hermes
provide their own ACP commands. Ambassador matches exact known MCP client and
ACP agent names, but treats reported versions as diagnostic metadata.

After registration, ask **Check my Embassys inbox.** It shows action calls
awaiting the user's answer and unread results returned by other identities.
Embassys permission requests go to the grantor's registered email instead of
their agent inbox. Reading a result does not remove it. The agent sends the
supplied receipt after accepting it.

If a direct agent asks ACP for permission to execute a provider tool,
Ambassador keeps that request open and asks that agent's owner through Embassys
email.
It continues only after the correlated decision returns through central
polling; the provider receives your exact selected option ID unchanged.

The central integration uses the unversioned REST API at
`https://mcp.embassys.ai`. Verification binds the central token to an
Ambassador-owned P-256 key. Protected requests use Bearer authorization plus a
separate DPoP proof. Ambassador does not use the central MCP endpoint.

For the complete permission, action, and result flow, see
[Request and answer an action](docs/action-workflow.md). Ambassador can save the
exact action payload with a permission request and submit it once after approval.
The inbox pages through pending calls, unread results, and outbound status.
Each encrypted store allows 1 GiB; reads remain bounded.

## Wait for a response

The unpublished workflow candidate uses `message_box` for requests, checks,
owner questions, replies and receipts. An initial request waits up to ten
minutes for a related update. If it times out, ask the agent to check the same
saved request again. The next check starts another wait without resubmitting
the action. Configure the client tool timeout to at least 660 seconds, or use a
shorter explicit wait where the client cannot hold the full request.

OpenClaw's original-conversation extension and Claude Code's channel proxy are
experimental. The foreground wait and inbox remain available. See the
[client support matrix](docs/client-delivery.md) for tested behavior and setup.

## Development logs

The candidate writes request and response bodies even without `--verbose`.
Credentials are redacted. Startup prints the exact directory: `diagnostics`
inside the platform state directory listed below. Copy `events.jsonl` and its
rotated files from that directory to export the log. Retention is bounded to
four 8 MiB files, with bounded individual records. `clean` preserves these
logs so a failed session can still be diagnosed.

## Inspect direct sessions

Keep Ambassador running and use:

```sh
npx --yes @embassys/ambassador@latest sessions list
npx --yes @embassys/ambassador@latest sessions show <session-id>
```

Add `--verbose` to `show` for bounded tool events. Stop Ambassador before
using `sessions delete <session-id>` or `sessions forget <session-id>`.

## Repeat a local registration test

Reset local Ambassador state:

```sh
npx --yes @embassys/ambassador@latest clean
```

If Ambassador is running, `clean` asks whether to stop it and clear local state.
`start` also offers to stop the running instance before starting a new one.
Both prompts default to No. Non-interactive commands require it to be stopped
first. If the running version cannot accept the stop request, stop it in its
terminal and retry.

The command removes the local registration, encrypted credentials, delivery
profile, webhook and internal control secrets, pending-action inbox,
notification journal, received-action-result inbox, and saved outbound intents. It also removes
interrupted state writes. It preserves development diagnostics and the
owner-only directory and singleton lock needed to prevent concurrent cleanup.

For a manual reset, move the entire local Ambassador state directory to Trash
or to an owner-only backup after stopping Ambassador:

- macOS: `~/Library/Application Support/ambassador`
- Linux: `$XDG_STATE_HOME/ambassador`, or `~/.local/state/ambassador` when
  `XDG_STATE_HOME` is unset
- Windows: `%LOCALAPPDATA%\ambassador`

Remove the directory as one unit. Deleting only `delivery-profile.json`, an
encrypted value, or its key leaves an intentionally invalid partial state. The
next `ambassador start` enables registration again. Neither reset
method deletes the central registration, so use a new disposable email when
rerunning without server-side cleanup. Neither changes the agent's normal
provider configuration or credentials.

## Implementation status

The current source includes the approved durable workflow redesign in
[ADR 0061](docs/adr/0061-durable-workflows-and-client-delivery.md): independent
receive, processing, provider and acknowledgement workers; exact action schemas;
long waits; owner input; explicit result receipts; and development logs. This
candidate has not been published. The `@latest` commands above install the
published release; they do not install these working-tree changes.

The published 0.2.18 baseline passed real Codex, Claude Code, Hermes and OpenClaw
delivery qualification. Current candidate evidence and remaining release gates
are recorded separately in [qualification](docs/qualification.md) and
[the implementation plan](docs/implementation-plan.md). Gemini CLI and
Antigravity remain inactive under
[ADR 0043](docs/adr/0043-remove-gemini-and-defer-antigravity.md).

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

## Workflow candidate

The unpublished ADR 0061 candidate uses one typed message_box for business
operations, ten-minute foreground waits and explicit result receipts. It also
adds durable owner questions and development body logs.
See [client delivery](docs/client-delivery.md) for timeout settings, optional
OpenClaw return, experimental Claude Code channels and qualification limits.
