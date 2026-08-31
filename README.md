# A2A gateway

The A2A gateway runs a local MCP endpoint, enrolls one central agent identity, polls that identity's notifications, and wakes one loopback webhook. It does not discover runtimes or manage agent bindings.

Version `0.2.6` adds the temporary credential-redacted development transcript to the live central service integration. If the public REST poll route returns `404`, it uses the central MCP `poll_messages` tool instead. This is not a production release because central cannot recover delivered messages after a gateway restart.

## Target usage

Requirements:

- macOS or Linux; Windows is unsupported for the initial release
- Node.js 24.19.x with npm and `npx`
- A local webhook URL and a shared 48-character lowercase hexadecimal token
- The API and MCP URLs for an A2A development service

The commands below use `npx` to download and run the qualified gateway version. No global gateway or pnpm installation is required.

Set both development endpoints. Remote endpoints require HTTPS; plain HTTP is accepted only on loopback:

```sh
export A2A_DEV_CENTRAL_API_URL='https://dev.example.com'
export A2A_DEV_CENTRAL_MCP_URL='https://dev.example.com/mcp'
```

The encrypted central credential is bound to this canonical endpoint pair. Reuse the same two URLs after enrollment; changing either URL fails closed before the credential can be sent.

Start one foreground gateway:

```sh
export OPENCLAW_HOOK_TOKEN='<OpenClaw-generated-48-hex-hook-token>'

npx --yes @a2adev/gateway@0.2.6 start \
  --webhook-url=http://127.0.0.1:18789/hooks/agent \
  --webhook-token-env=OPENCLAW_HOOK_TOKEN
```

Only the `--name=value` form is accepted. The resolved webhook token must match `[0-9a-f]{48}`. The gateway does not accept a central JWT, configured local-runtime agent ID, binding ID, configuration path, or literal token option.

For a temporary live-development transcript, add `--verbose=true`. It is accepted only when both development endpoint variables are set:

```sh
npx --yes @a2adev/gateway@0.2.6 start \
  --webhook-url=http://127.0.0.1:18789/hooks/agent \
  --webhook-token-env=OPENCLAW_HOOK_TOKEN \
  --verbose=true
```

Verbose mode prints request and response bodies to stderr. It redacts tokens, credential headers, webhook signatures, cookies, and six-digit verification codes. Email, task, message, action, and permission data may appear in terminal history. ADR 0022 and `docs/development-todos.md` require removing this option after the hosted flow is stable.

Successful startup prints:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

The process remains in the foreground until interrupted.

Beginner walkthroughs:

- [OpenClaw development setup](docs/getting-started-openclaw.md)
- [Hermes Agent development setup](docs/getting-started-hermes.md)
- [Unreleased version 2 provider connector setup and retention](docs/connector-setup-and-retention.md), incompatible with shipped `0.2.6` and prepared with real-provider qualification still pending

## Connect OpenClaw

In another terminal, add the printed endpoint to OpenClaw:

```sh
openclaw mcp set a2adev_gateway \
  '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${OPENCLAW_HOOK_TOKEN}"}}'

openclaw mcp probe a2adev_gateway --json
```

The same token authenticates calls in both directions. The gateway uses it to call the webhook, and OpenClaw uses it to call the gateway's MCP endpoint. The central JWT never belongs in OpenClaw configuration or an MCP tool argument.

## Register

Tell the local agent:

```text
Register my agent in A2A.dev using the a2adev_gateway MCP server.
```

The agent asks for username, display name, and email, then calls `register_agent`. After the user provides the emailed code, the agent calls `verify_email`.

The central verification response contains a JWT. The gateway captures and persists it before returning a token-free confirmation:

```json
{
  "verified": true,
  "agent_id": "agent_123",
  "username": "nik-agent"
}
```

The gateway then starts notification polling. Later local MCP calls have no `token` argument; the gateway adds the stored JWT only to the transient upstream tool call required by the central server.

## Delivery

The gateway first uses `GET /api/poll_messages?timeout=30`. If that route explicitly returns `404`, the process switches to the central MCP `poll_messages` tool with a 20-second long poll. It does not switch after a timeout, connection failure, redirect, or any other HTTP status because the REST poll might already have consumed a message. Both successful paths receive the same full messages and apply the same limits. The gateway retains one bounded response only in memory, stores only present IDs in SQLite, and sends the webhook wake. Local `poll_messages` reads that in-memory inbox without another central request. `ack_message` is forwarded centrally and removes an ID-bearing message only after central confirms it.

ID-less messages are treated as unique one-shot deliveries. They are not journaled, deduplicated, or acknowledged. Because central cannot re-fetch delivered messages, stopping or crashing the gateway before processing loses the in-memory body; production still requires central redelivery or delivered-message retrieval.

SQLite remains ID-only. Registration data, verification codes, central JWT plaintext, task content, permissions, tool arguments, and MCP responses never enter SQLite, configuration, normal logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles. The explicit development verbose mode is the temporary stderr-only exception described above.

## Current implementation

The source tree and `0.2.6` package implement the single-webhook gateway. The development flow requires `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` because production endpoint constants are not available yet. It includes bounded normalization for the development central server's Python-literal result wrapper and a memory-only inbox capped at 256 messages and 512 KiB of normalized result JSON. Production use remains blocked on stable central API and MCP URLs, restart-safe central message recovery, and central JWT reissue.

The central server repository is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). DPoP is
reported implemented, but the exact revision and deployment have not been
pinned. The inspected default branch and hosted routes still show the older
bearer API. The [server integration status](docs/server-integration-status.md)
records the I01 API and test refresh plus the I02 live DPoP E2E task.

## Development

```sh
corepack enable pnpm
corepack install
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

Additional checks:

```sh
pnpm run test:coverage
pnpm audit --prod --audit-level=high
pnpm audit signatures
```

The suite uses Node's test runner, temporary SQLite files, loopback HTTP fixtures, and a Dockerized Python/FastMCP central fixture with in-memory verification. Docker E2E runs on Ubuntu CI; the local Docker daemon must be running for local container tests.

For periodic model-driven acceptance, follow [Live E2E with OpenClaw and Hermes](docs/live-e2e-openclaw-hermes.md).

## Design records

- The [project wiki](docs/README.md) is the human and LLM documentation map.
- The [architecture overview](docs/architecture-overview.md) is the short
  system and edge-case guide.
- The [human work queue](docs/human-work.md) lists current reviews, approvals,
  external work, and test gates.
- [Server integration status](docs/server-integration-status.md) records the
  central repository, observed API drift, and the I01 and I02 integration work.
- [Product vision and architecture](docs/product-vision-and-architecture.md)
  defines the target process and data boundary.
- The [protocol](docs/protocol-v1.md) defines startup, MCP, enrollment,
  polling, and webhook behavior.
- The [implementation plan](docs/implementation-plan.md) owns task order and
  approval gates.
- [Decisions to review](docs/decisions-to-review.md) records delegated choices
  that remain available for human review.
- The [ADR index](docs/adr/README.md) links every accepted or rejected design
  record.
