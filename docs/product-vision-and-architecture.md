# A2A gateway

Read this before working on the project.

## Product

The gateway is one foreground process between a local agent runtime and the central A2A service. It runs an authenticated loopback MCP server, enrolls one central agent identity, polls that identity's notification stream, and wakes one configured webhook target.

The gateway does not discover OpenClaw, inspect agents, choose a runtime adapter, or manage bindings. The user supplies a literal-loopback webhook URL and an environment-variable reference for its bearer token:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The same bearer token authenticates calls from the local MCP client. The gateway prints `http://127.0.0.1:8787/mcp` after it binds successfully. The user configures that address in the local agent runtime.

## Rules

- One process owns one webhook target and one central identity.
- The process runs in the foreground and accepts exactly two required named startup options in `--name=value` form.
- The MCP listener binds only to `127.0.0.1:8787` and authenticates every request with the webhook bearer token.
- Before enrollment, the local MCP catalog contains only the central-JWT-exempt registration and verification tools.
- The gateway captures the central JWT from a successful verification response before returning a token-free result to the agent.
- Future central MCP calls and notification polls receive the stored JWT from the gateway. Local tool schemas never contain a JWT argument; the proxy adds `token` only to the transient upstream tool call required by the current central MCP contract.
- The durable notification journal contains opaque IDs and relay state only.
- MCP arguments and results, task content, permission data, registration email, verification codes, and plaintext JWTs never enter SQLite, configuration, logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles.
- The gateway does not run a model or hold model-provider credentials.
- No listener binds beyond loopback.

## Flow

```text
Local agent runtime
  |  authenticated MCP using webhook token
  v
Gateway MCP server on 127.0.0.1:8787
  |  registration before enrollment
  |  stored central JWT after verification
  v
Central MCP server

Central ID notification API
  |  authenticated poll after enrollment
  v
Gateway ID-only relay
  |  bearer webhook wake
  v
Configured local webhook
```

### Startup

1. Acquire the singleton lock before resolving tokens, opening credentials, binding MCP, polling, or sending a webhook.
2. Resolve the webhook token from the named environment variable.
3. Bind the authenticated MCP endpoint to `127.0.0.1:8787`.
4. Load an existing central JWT from the approved credential store, if present.
5. Start ID-only notification polling only when a central JWT is available.
6. Print the MCP endpoint and wait until interrupted.

### Enrollment

1. The user tells the local agent to register with A2A.
2. The agent gathers username, display name, and email through normal conversation.
3. The agent calls local `register_agent`; the gateway forwards it centrally without a central JWT.
4. The user gives the emailed code to the agent.
5. The agent calls local `verify_email`; the gateway forwards it centrally.
6. The gateway validates the upstream result, extracts and persists the central JWT, removes it from the local result, and enables authenticated tools and polling.

If persistence fails, verification does not report local success. A second verification cannot replace an enrolled identity silently.

### Delivery

1. The gateway polls the central ID view with the stored JWT.
2. The central service returns opaque message IDs without consuming the content-bearing MCP message.
3. The gateway stores each new ID, then independently queues the idempotent `ack_notification` persistence acknowledgement and webhook wake.
4. Notification acknowledgement stops ID redelivery but leaves the content available through MCP; acknowledgement retries do not block the wake.
5. The webhook receives a fixed instruction and an idempotency header.
6. The agent calls the gateway's MCP `poll_messages` tool to retrieve content from the central MCP server.
7. The agent processes the message and calls the separate `ack_message` content acknowledgement through the gateway. Content remains retrievable and the same wake ID remains eligible for redrive until this succeeds.

## Ownership

| Component | Responsibility |
| --- | --- |
| Central service | Registration, email verification, agent JWT issuance, authorization, message content, permissions, and MCP tools |
| Gateway MCP path | Local bearer authentication, bootstrap tools, JWT capture, token-free local results, transient upstream `token` injection, limits, and cancellation |
| Gateway relay | ID-only polling, durable IDs, wake retries, and acknowledgement observation |
| Local runtime | User interaction, MCP tool use, model execution, and webhook handling |

## Current release boundary

The published `0.1.0` package implements the discarded setup, binding, adapter, and controller contract. It does not implement this design. Do not present `0.1.0` as an end-to-end A2A integration.

The replacement keeps Node 24, npm distribution, SQLite for ID-only relay state, bounded HTTP operations, and singleton locking. It removes general JSON configuration, runtime presets, agent management, and native service installation.

## Open decisions

- Approve the production MCP SDK in ADR `0018-mcp-sdk.md`.
- Approve central JWT persistence in ADR `0019-central-credential-storage.md`.
- Obtain stable production central API and MCP URLs for package constants.
- Add central support for an ID-only, non-consuming notification view and structured verification results.
- Define central JWT revocation, reissue, and intentional local reset.
- Require central token reissue before relying on one-time verification in public use; a crash after remote issuance but before local persistence is otherwise unrecoverable.
