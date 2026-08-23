# A2A sidecar

The A2A sidecar is a per-user daemon that wakes local agent runtimes after a central controller authorizes work. It receives opaque IDs and timing metadata. Task text, results, permissions, grants, and MCP payloads do not cross this process.

This repository contains a working development implementation. It is not ready for public distribution. See `docs/implementation-status.md` for the remaining release work.

## Requirements

- Node.js 24.19.x
- npm 11

Install and verify:

```sh
npm ci
npm run check
npm run build
```

The local machine may use another Node release for development, but CI and release qualification target Node 24.19.

## Configure

The CLI stores references to environment variables, never literal credentials.

```sh
export A2A_CONTROLLER_TOKEN='controller-issued-token'

node dist/cli.js setup \
  --controller-url https://controller.example \
  --controller-token-env A2A_CONTROLLER_TOKEN
```

Add a generic webhook binding:

```sh
export A2A_RUNTIME_SECRET='binding-secret'

node dist/cli.js agent add binding_local \
  --adapter generic \
  --url http://127.0.0.1:8644/webhooks/a2a \
  --health-url http://127.0.0.1:8644/health \
  --secret-env A2A_RUNTIME_SECRET
```

Hermes uses the same `--secret-env` form. OpenClaw uses `--agent-id` and `--token-env`:

```sh
node dist/cli.js agent add binding_openclaw \
  --adapter openclaw \
  --url http://127.0.0.1:18789/hooks/agent \
  --agent-id agent_local \
  --token-env A2A_OPENCLAW_TOKEN
```

Run diagnostics and start the daemon in the foreground:

```sh
node dist/cli.js doctor
node dist/cli.js run
```

Every command accepts `--config <path>`. Read-only and fully noninteractive commands accept `--json`.

## User service

The CLI uses `launchd` on macOS, `systemd --user` on Linux, and Task Scheduler on Windows.

```sh
node dist/cli.js service install
node dist/cli.js service start
node dist/cli.js service status --json
```

Service definitions contain the executable, CLI path, and config path. They do not contain credentials. Environment-referenced credentials must exist in the service manager's environment.

## Delivery behavior

The sidecar commits each notification and cursor to SQLite before acknowledgement. A wake retry keeps the same `delivery_id`. Reports stay in a durable outbox until the controller confirms them.

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
