# A2A gateway

The A2A gateway is a per-user daemon that wakes local agent runtimes after a central controller authorizes work. The published `0.1.0` development preview implements a locally durable, ID-only relay against its fake v1 controller contract.

ADR `0016-combined-gateway-mcp-proxy.md` approves the next short- and medium-term design: the same process will also expose an authenticated loopback MCP proxy and inject a central agent JWT for each binding. MCP content may then pass through process memory, but it must never enter configuration, SQLite, diagnostics, metrics, or logs. The proxy is not implemented yet.

This repository contains a working development preview. It is not ready for public beta. See `docs/implementation-status.md` for the remaining release work.

## Requirements

- Node.js 24.19.x
- npm 11

Install globally for background operation:

```sh
npm install --global @a2adev/gateway
a2a-gateway version
```

Run a temporary command without installing:

```sh
npx @a2adev/gateway version
```

Install and verify a development checkout:

```sh
npm ci
npm run check
npm run build
npm link
```

The local machine may use another Node release for development, but CI and release qualification target Node 24.19.

## Configure

The current CLI stores references to environment variables, never literal credentials. This configuration covers the existing relay; the approved per-binding central JWT and local MCP settings still need a separate CLI and configuration review.

The available central `/api/poll_messages` implementation is not compatible with the relay's crash-safety contract yet: it marks messages delivered while polling and lacks durable redelivery and idempotent acknowledgement. Do not treat the current setup as end-to-end durable against that service.

```sh
export A2A_CONTROLLER_TOKEN='controller-issued-token'

a2a-gateway setup \
  --controller-url https://controller.example \
  --controller-token-env A2A_CONTROLLER_TOKEN
```

Add a generic webhook binding:

```sh
export A2A_RUNTIME_SECRET='binding-secret'

a2a-gateway agent add binding_local \
  --adapter generic \
  --url http://127.0.0.1:8644/webhooks/a2a \
  --health-url http://127.0.0.1:8644/health \
  --secret-env A2A_RUNTIME_SECRET
```

Hermes uses the same `--secret-env` form. OpenClaw uses `--agent-id` and `--token-env`:

```sh
a2a-gateway agent add binding_openclaw \
  --adapter openclaw \
  --url http://127.0.0.1:18789/hooks/agent \
  --agent-id agent_local \
  --token-env A2A_OPENCLAW_TOKEN
```

Run diagnostics and start the daemon in the foreground:

```sh
a2a-gateway doctor
a2a-gateway run
```

Every command accepts `--config <path>`. Read-only and fully noninteractive commands accept `--json`.

## Planned local MCP proxy

Independently running agents will call an authenticated MCP endpoint bound to loopback. The combined gateway process will map each authenticated local caller to one fixed binding and inject that binding's central JWT. Central JWTs will not be MCP tool arguments.

Every G5 decision listed in `docs/implementation-plan.md`, including ID scope, tool catalog, JWT lifecycle, side-effect semantics, transport, authentication, configuration, CLI, dependencies, and migration, remains unapproved. Registration or verification tools will not return central JWTs through the local proxy. Do not configure an agent against a gateway MCP URL yet.

## Background gateway

One gateway handles every configured agent. `start` uses `launchd` on macOS, `systemd --user` on Linux, and Task Scheduler on Windows. It registers the native user service automatically on first use.

```sh
a2a-gateway start
a2a-gateway status --json
a2a-gateway restart
a2a-gateway stop
```

Service definitions contain the executable, CLI path, and config path. They do not contain credentials. Environment-referenced credentials must exist in the service manager's environment.

## Delivery behavior

The gateway relay commits each notification and cursor to SQLite before acknowledgement. A wake retry keeps the same `delivery_id`. Reports stay in a durable outbox until the controller confirms them.

The generic webhook sends this strict body:

```json
{"protocol_version":1,"delivery_id":"delivery_...","sent_at":"2026-08-23T12:00:02.000Z"}
```

It signs `<unix-seconds>.<exact-body>` with HMAC-SHA256 and sends the lowercase hexadecimal digest in `X-Webhook-Signature-V2`. The timestamp is in `X-Webhook-Timestamp`.

Hermes and OpenClaw presets are best-effort. Their native duplicate caches do not survive a runtime restart, so neither preset can promise one model turn per delivery. The generic adapter qualifies for the stronger contract only when its receiver durably stores the delivery-to-session mapping.

## Tests

```sh
npm test
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

The suite uses Node's test runner, temporary SQLite journals, and local HTTP servers. It does not call a model or an external controller.

The GitHub Actions workflow runs lint, type checks, tests, and the production dependency audit on Linux, macOS, and Windows with Node 24.19.

## Design records

- `docs/product-vision-and-architecture.md` defines the product boundary.
- `docs/protocol-v1.md` defines wire behavior and state transitions.
- `docs/decisions-to-review.md` lists every provisional choice made under delegated approval.
- `docs/adr/` contains the corresponding decision records.
- `docs/adr/0016-combined-gateway-mcp-proxy.md` records the approved interim combined-process architecture.
