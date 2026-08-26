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
- The consuming notification response and its message bodies remain in bounded process memory only. The durable notification journal contains opaque IDs and webhook relay state only.
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

Central consuming notification API
  |  authenticated full-message poll after enrollment
  v
Gateway in-memory inbox and ID-only journal
  |  bearer and HMAC webhook wake
  v
Configured local webhook
```

### Startup

1. Acquire the singleton lock before resolving tokens, opening credentials, binding MCP, polling, or sending a webhook.
2. Resolve and validate the 48-character lowercase hexadecimal webhook token from the named environment variable.
3. Bind the authenticated MCP endpoint to `127.0.0.1:8787`.
4. Load an existing central JWT from the approved credential store, if present.
5. Start consuming notification polling only when a central JWT is available.
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

1. The gateway sends `GET /api/poll_messages?timeout=30` with the stored JWT.
2. The central service returns full queued messages and atomically marks them delivered.
3. The gateway validates the complete response, keeps message bodies only in a bounded in-memory inbox, and stores only present message IDs in SQLite.
4. The webhook receives a fixed instruction, bearer and timestamped HMAC authentication, and ID-based deduplication headers. An ID-less message receives a process-local unique wake key but is not journaled.
5. The agent calls the gateway's local MCP `poll_messages` tool. The gateway serves the in-memory inbox rather than polling central MCP again.
6. For an ID-bearing message, the agent calls `ack_message`; the gateway forwards it centrally and removes the in-memory body only after central confirms `status: "acked"`.
7. An ID-less message is returned once, is treated as unique, and is neither deduplicated nor acknowledged.

The central API has no delivered-message recovery operation. A gateway stop or crash after the consuming REST poll but before local processing therefore loses the in-memory body. The gateway discards the corresponding nonterminal wake state on restart rather than waking an agent for unavailable content. Central redelivery or a delivered-message fetch API is required to close this recovery gap.

## Ownership

| Component | Responsibility |
| --- | --- |
| Central service | Registration, email verification, agent JWT issuance, authorization, message content, permissions, and MCP tools |
| Gateway MCP path | Local bearer authentication, bootstrap tools, JWT capture, token-free local results, in-memory message retrieval, transient upstream `token` injection, limits, and cancellation |
| Gateway relay | Consuming full-message polling, bounded in-memory bodies, ID-only durable wake state, retries, and acknowledgement observation |
| Local runtime | User interaction, MCP tool use, model execution, and webhook handling |

## Current release boundary

Version `0.2.3` packages the single-webhook replacement and compatibility with the live central REST and MCP interfaces for development use. A working development flow supplies both `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL`; they are temporary environment overrides, not CLI options or production constants.

The replacement keeps Node 24, npm-registry distribution, pnpm project tooling, SQLite for ID-only relay state, bounded in-memory message handling, bounded HTTP operations, and singleton locking. It removes general JSON configuration, runtime presets, agent management, and native service installation. Production use remains blocked on the central recovery work listed below.

## Open decisions

- Obtain stable production central API and MCP URLs for package constants.
- Add central support for redelivery or retrieval of delivered but unacknowledged messages after gateway restart.
- Replace the temporary Python-literal MCP wrapper with native structured results before removing the bounded gateway compatibility parser.
- Define central JWT revocation, reissue, and intentional local reset.
- Require central token reissue before relying on one-time verification in public use; a crash after remote issuance but before local persistence is otherwise unrecoverable.
