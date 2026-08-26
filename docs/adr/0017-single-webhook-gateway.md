# 0017 Single-webhook gateway

Status: accepted

Date: 2026-08-25

Updated: 2026-08-26 for runtime-agnostic dual webhook authentication

## Problem

The earlier CLI and configuration model asked the gateway to discover or configure runtimes, manage bindings, and receive a central JWT before startup. The intended user flow is smaller. A user already has a local webhook URL and token. Central registration happens later through MCP.

## Decision

One gateway process owns one webhook target and, after enrollment, one central agent identity. It does not know the local runtime type or a configured local-runtime agent ID.

The normal command has exactly two required named options:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The CLI accepts only the `--name=value` form for these options. The token option names an environment variable because literal secrets in command arguments leak through shell history and process listings.

`start` runs in the foreground until interrupted. It does not discover a runtime, create a binding, write general configuration, install an OS service, or modify another application's files. On successful startup it prints the stable local MCP endpoint:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

The webhook URL must use the literal loopback address `127.0.0.1`. The webhook token must use OpenClaw's generated 48-character lowercase hexadecimal format. The MCP listener binds only to `127.0.0.1`. It requires `Authorization: Bearer <webhook-token>` on every request. Reusing the webhook token avoids a second local credential without disclosing the local MCP bearer to a remote webhook recipient. Compromise of that token still grants both webhook wake and local MCP access; this tradeoff is accepted for the single-user local design.

The central API and MCP URLs are product constants, not user-facing CLI options. Until those constants are available, the `0.2.0` development release accepts `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` as a paired environment override. A development flow sets both. Remote values require HTTPS, while loopback development servers may use HTTP. The override does not change the two-option CLI or add general configuration.

## Enrollment

Before enrollment, the local MCP server exposes only the central-JWT-exempt bootstrap tools `register_agent`, `verify_email`, and `resend_verification`. The local bearer check still applies.

1. The agent calls `register_agent`; the gateway forwards it to the central MCP server.
2. The user receives an email code and gives it to the agent.
3. The agent calls `verify_email`; the gateway forwards it.
4. The gateway extracts the central JWT from the successful upstream result, persists it in the credential store, and replaces the result with a token-free confirmation.
5. The gateway replaces the bootstrap catalog with authenticated tools, emits an MCP tool-list change notification, and starts notification polling with that JWT.
6. Future local authenticated tool schemas omit `token`; the gateway injects it only into the transient upstream tool arguments required by the current central MCP server.

The gateway never returns a central JWT to the local MCP client. Registration email, display name, verification code, MCP arguments, and MCP results pass through memory only.

A first successful verification owns the gateway identity. A later verification cannot silently replace it. Credential reset and central token reissue remain future operations.

An upstream authentication failure stops polling and authenticated tools without deleting or replacing the stored credential.

## Notification and wake behavior

The gateway polls an ID-only central notification view after enrollment. The central MCP `poll_messages` tool remains the content-bearing path used by the agent. The notification view must not consume or hide the message from that tool.

The fixed wake body omits `agentId`, so a webhook owner chooses its default target. The only variable content is the opaque message ID. Every request carries the configured bearer token and a generic HMAC V2 signature over the exact body, using the same token as its key and a current Unix timestamp. `Idempotency-Key` and `X-Request-ID` both carry the message ID. The gateway sends all of these headers for every target; it does not select a runtime or authentication mode.

The gateway stores only message IDs and relay state. It never stores MCP bodies, task data, permissions, results, email addresses, verification codes, or plaintext central JWTs in SQLite, configuration, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.

The `0.2.1` package retains the `0.2.0` loopback Hermes bridge for existing installations that still target port `8645`, but current setup sends signed wakes directly to Hermes. The compatibility file does not change the gateway process or add runtime selection.

The MCP endpoint requires its exact loopback `Host`, permits a missing `Origin` for non-browser clients, rejects any other supplied `Origin`, limits request and response sizes, applies deadlines, rejects redirects, and rechecks the bearer token on every request. MCP session IDs never act as authentication.

## Removed behavior

The active design has no `setup`, `agent add`, `agent list`, `agent remove`, `agent test`, `stop`, `restart`, `status`, `doctor`, or `run` command. It has no binding IDs, runtime adapters, runtime presets, JSON configuration file, or native service definitions.

The published `0.1.0` package retains those behaviors. Replacement source deletes them after the new design passes the required tests rather than carrying compatibility code into the next release, because no released central integration depends on it.

The replacement uses new `a2a-gateway` state paths and ignores legacy `a2a-sidecar` configuration and journal files. It does not delete them automatically.

## Approval

The user approved the two-option, agent-agnostic startup and MCP enrollment flow on 2026-08-25. The same-day development release request approved the paired environment endpoint override without adding CLI options. The user also directed the project to delete obsolete ADRs instead of retaining them as superseded history.
