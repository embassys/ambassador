# A2A gateway

The A2A gateway runs a local MCP endpoint, enrolls one central agent identity, polls that identity's notifications, and wakes one loopback webhook. It does not discover runtimes or manage agent bindings.

Version `0.2.1` supports the complete flow against an A2A development service supplied through environment variables. It is not a production release: the production central contract and stable endpoint constants are still pending.

## Target usage

Requirements:

- macOS or Linux; Windows remains unqualified for `0.2.1`
- Node.js 24.19.x
- pnpm 11.22.0 through Corepack
- A local webhook URL and a shared 48-character lowercase hexadecimal token
- The API and MCP URLs for an A2A development service

Install the package:

```sh
corepack enable pnpm
corepack install --global pnpm@11.22.0
pnpm setup
```

Run the `source` command printed by `pnpm setup`, or open a new terminal. Then install the gateway:

```sh
pnpm --allow-build=better-sqlite3 add --global @a2adev/gateway@0.2.1
```

Set both development endpoints. Remote endpoints require HTTPS; plain HTTP is accepted only on loopback:

```sh
export A2A_DEV_CENTRAL_API_URL='https://dev.example.com'
export A2A_DEV_CENTRAL_MCP_URL='https://dev.example.com/mcp'
```

The encrypted central credential is bound to this canonical endpoint pair. Reuse the same two URLs after enrollment; changing either URL fails closed before the credential can be sent.

Start one foreground gateway:

```sh
export OPENCLAW_HOOK_TOKEN='<OpenClaw-generated-48-hex-hook-token>'

a2a-gateway start \
  --webhook-url=http://127.0.0.1:18789/hooks/agent \
  --webhook-token-env=OPENCLAW_HOOK_TOKEN
```

Only the `--name=value` form is accepted. The resolved webhook token must match `[0-9a-f]{48}`. The gateway does not accept a central JWT, configured local-runtime agent ID, binding ID, configuration path, or literal token option.

Successful startup prints:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

The process remains in the foreground until interrupted.

Beginner walkthroughs:

- [OpenClaw development setup](docs/getting-started-openclaw.md)
- [Hermes Agent development setup](docs/getting-started-hermes.md)

## Connect OpenClaw

In another terminal, add the printed endpoint to OpenClaw:

```sh
openclaw mcp set a2a \
  '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${OPENCLAW_HOOK_TOKEN}"}}'

openclaw mcp probe a2a --json
```

The same token authenticates calls in both directions. The gateway uses it to call the webhook, and OpenClaw uses it to call the gateway's MCP endpoint. The central JWT never belongs in OpenClaw configuration or an MCP tool argument.

## Register

Tell the local agent:

```text
Register this agent with A2A.
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

The central notification API returns opaque IDs without consuming the MCP message. The gateway commits an ID to SQLite, confirms that persistence through `ack_notification`, then sends a fixed webhook wake with bearer and timestamped HMAC authentication. The same opaque ID is used for `Idempotency-Key` and `X-Request-ID`. The agent retrieves content through the local MCP `poll_messages` tool and separately confirms processing through `ack_message`. Until that acknowledgement succeeds, content remains retrievable and the gateway periodically re-drives the same wake ID.

SQLite remains ID-only. Registration data, verification codes, central JWT plaintext, task content, permissions, tool arguments, and MCP responses never enter SQLite, configuration, logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles.

## Current implementation

The source tree and `0.2.1` package implement the single-webhook gateway. The development flow requires `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` because production endpoint constants are not available yet. Production use remains blocked on stable central API and MCP URLs, the ID-only notification view, structured verification results, and central JWT reissue.

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

## Design records

- `docs/product-vision-and-architecture.md` defines the target process and data boundary.
- `docs/protocol-v1.md` defines startup, MCP, enrollment, polling, and webhook behavior.
- `docs/implementation-plan.md` is the active task list and approval gate.
- `docs/decisions-to-review.md` lists provisional and proposed choices.
- `docs/adr/0017-single-webhook-gateway.md` records the approved design.
