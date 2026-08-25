# A2A gateway

The A2A gateway runs a local MCP endpoint, enrolls one central agent identity, polls that identity's notifications, and wakes one loopback webhook. It does not discover runtimes or manage agent bindings.

The published `0.1.0` package contains the older relay-only implementation. The command below documents the approved replacement and does not work in `0.1.0` yet.

## Target usage

Requirements:

- Node.js 24.19.x
- npm 11
- A local webhook URL and its bearer token

Install the package:

```sh
npm install --global @a2adev/gateway
```

Start one foreground gateway:

```sh
export OPENCLAW_HOOK_TOKEN='your-existing-hook-token'

a2a-gateway start \
  --webhook-url=http://127.0.0.1:18789/hooks/agent \
  --webhook-token-env=OPENCLAW_HOOK_TOKEN
```

Only the `--name=value` form is accepted. The gateway does not accept a central JWT, configured local-runtime agent ID, binding ID, configuration path, or literal token option.

Successful startup prints:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

The process remains in the foreground until interrupted.

## Connect OpenClaw

In another terminal, add the printed endpoint to OpenClaw:

```sh
openclaw mcp set a2a \
  '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${OPENCLAW_HOOK_TOKEN}"}}'

openclaw mcp doctor a2a --probe
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

The central notification API returns opaque IDs without consuming the MCP message. The gateway commits an ID to SQLite, confirms that persistence through `ack_notification`, then sends a fixed OpenClaw-compatible webhook wake with the same ID as its idempotency key. The agent retrieves content through the local MCP `poll_messages` tool and separately confirms processing through `ack_message`. Until that acknowledgement succeeds, content remains retrievable and the gateway periodically re-drives the same wake ID.

SQLite remains ID-only. Registration data, verification codes, central JWT plaintext, task content, permissions, tool arguments, and MCP responses never enter SQLite, configuration, logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles.

## Current implementation

Version `0.1.0` still has setup, binding, adapter, JSON configuration, and user-service code. It has no local MCP listener, registration proxy, JWT interception, or ID-only compatibility with the available central API. See `docs/implementation-status.md` for the replacement plan.

The current package can still report its version:

```sh
npx @a2adev/gateway version
```

## Development

```sh
npm ci
npm run check
npm run build
```

Additional checks:

```sh
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

The current suite uses Node's test runner, temporary SQLite files, and loopback HTTP fixtures. The replacement plan adds a Dockerized Python/FastMCP central fixture with in-memory verification. Docker E2E runs on Ubuntu CI; the local Docker daemon must be running for local E2E.

## Design records

- `docs/product-vision-and-architecture.md` defines the target process and data boundary.
- `docs/protocol-v1.md` defines startup, MCP, enrollment, polling, and webhook behavior.
- `docs/implementation-plan.md` is the active task list and approval gate.
- `docs/decisions-to-review.md` lists provisional and proposed choices.
- `docs/adr/0017-single-webhook-gateway.md` records the approved design.
