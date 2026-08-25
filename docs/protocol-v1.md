# Gateway protocol v1

Status: accepted for the single-webhook design on 2026-08-25

## Startup contract

The public command is:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

Both options are required exactly once. The CLI accepts only the `--name=value` form. It rejects positional values, literal-token options, unknown options, setup options, agent IDs, binding IDs, and configuration paths.

`--webhook-url` accepts HTTPS or loopback HTTP without URL credentials. It rejects fragments. `--webhook-token-env` accepts an environment-variable name matching `[A-Za-z_][A-Za-z0-9_]*`; the resolved value must be non-empty and contain no CR or LF.

The process acquires its singleton lock before resolving durable credentials, binding MCP, polling, forwarding tools, or sending webhooks. It binds `127.0.0.1:8787` and prints this line only after the endpoint is ready:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

`SIGINT` and `SIGTERM` stop polling, reject new MCP work, allow bounded in-flight work to settle, close the listener and journal, and release the lock.

## Local MCP authentication

Every MCP request uses Streamable HTTP at `/mcp` and sends:

```text
Authorization: Bearer <resolved-webhook-token>
```

Missing, malformed, or incorrect authorization is rejected before parsing or forwarding the MCP body. Authentication uses a timing-safe comparison. MCP session IDs do not authenticate a request.

The server requires `Host: 127.0.0.1:8787`. It accepts a missing `Origin` header; when `Origin` is present, it must be exactly `http://127.0.0.1:8787`. It limits headers, request bodies, response bodies, sessions, concurrent calls, and call duration. It rejects redirects and does not follow upstream-provided URLs.

## Tool catalog

Before enrollment, expose only:

- `register_agent`
- `verify_email`
- `resend_verification`

These tools are exempt from central JWT injection, not from local bearer authentication. Their arguments and results pass through memory only.

After enrollment, remove the bootstrap tools and expose the approved authenticated central tool allowlist. Advertise MCP tool-list change support and send `notifications/tools/list_changed` after the JWT is durably stored. Remove the upstream `token` property from every local input schema. Reject local calls containing `token`, `jwt`, a credential selector, or an identity selector. Add `token: <central-agent-jwt>` only to the transient upstream `tools/call` arguments required by the current central MCP server.

Do not automatically retry a tool call after it may have reached the central service. Return a safe uncertain-outcome error for side-effecting calls.

## Verification and JWT custody

A successful upstream `verify_email` result must be this strict structured object:

```json
{
  "agent_id": "agent_123",
  "username": "nik-agent",
  "token": "central-jwt",
  "message": "Email verified successfully."
}
```

The local result is:

```json
{
  "verified": true,
  "agent_id": "agent_123",
  "username": "nik-agent",
  "message": "Email verified successfully."
}
```

The gateway:

1. validates the complete result;
2. extracts the JWT before local result serialization;
3. persists it atomically through the approved credential store;
4. enables authenticated tools and notification polling; and
5. returns only token-free identity and verification fields.

Do not report local verification success if credential persistence fails. Do not retain the upstream response for replay. Malformed results, multiple token fields, or a token in an unexpected location fail closed.

One stored JWT owns the process identity. Concurrent verification attempts serialize. A later successful result cannot replace the stored identity without a future explicit reset operation.

An upstream `401` stops notification polling and rejects authenticated tools with `central_authentication_failed`. The gateway keeps the encrypted credential for diagnosis and never attempts silent registration, token refresh, replacement, or deletion.

## Notification API

After enrollment, the gateway sends a JWT-authenticated long poll:

```text
GET /api/poll_messages?timeout=30&view=ids
Authorization: Bearer <central-agent-jwt>
```

The response contains only opaque IDs:

```json
{"messages":[{"id":"0f56d6f4-6073-4f75-9f31-72d7d760271a"}]}
```

The ID view does not mark the content message delivered or acknowledged. It repeats an unacknowledged ID after reconnects. IDs are unique within the one enrolled identity and use 1 to 128 URI-unreserved ASCII characters.

The gateway validates the full response before storing any ID. Unknown fields, duplicate conflicts, invalid IDs, task content, permission content, tool arguments, and results reject the response.

After the SQLite commit, the gateway sends an idempotent persistence acknowledgement:

```http
POST /api/ack_notification
Authorization: Bearer <central-agent-jwt>
Content-Type: application/json

{"message_id":"0f56d6f4-6073-4f75-9f31-72d7d760271a"}
```

This acknowledgement stops ID notification redelivery. It does not mark the message content delivered or processed and does not hide it from MCP `poll_messages`.

## Durable relay

SQLite stores only:

- schema version;
- notification ID;
- delivery state;
- attempt count and next attempt time;
- whether a wake may have reached the webhook; and
- terminal acknowledgement observation.

The journal keeps an ID-only outbox entry until `ack_notification` succeeds. Repeated notification acknowledgements return success.

SQLite contains no binding, cursor, webhook URL, webhook token, central JWT, MCP argument, MCP result, registration data, or task content.

The replacement uses new `a2a-gateway` state directories and does not read the legacy `a2a-sidecar` configuration or journal. It leaves legacy files untouched; no shipped central integration depends on migrating them.

An exact repeated ID is coalesced. One wake attempt per ID runs at a time. The gateway records an attempt before sending the webhook. After an uncertain outcome it retries the same ID with bounded exponential backoff and equal jitter.

## Webhook wake

The gateway sends:

```http
POST <webhook-url>
Authorization: Bearer <resolved-webhook-token>
Idempotency-Key: <message-id>
Content-Type: application/json
```

For the current OpenClaw-compatible contract, the body is:

```json
{
  "message": "A2A message <message-id> is ready. Use the A2A MCP tools to retrieve and process it.",
  "name": "A2A Gateway",
  "deliver": false,
  "wakeMode": "now"
}
```

The body omits `agentId`, so the webhook owner chooses its default target. The message ID is the only variable content. A `2xx` response means the webhook accepted the wake, not that the agent completed the work.

## MCP message retrieval and acknowledgement

The local agent calls `poll_messages` through the gateway after waking. The gateway injects the central JWT and the central MCP server returns the full message. That content never enters the relay journal.

The local agent calls `ack_message` after processing. The gateway forwards it with the central JWT and marks the matching local ID terminal only after the central service confirms an idempotent content acknowledgement. `ack_message` does not serve as the relay persistence acknowledgement.

## Deadlines and limits

| Operation | Deadline |
| --- | --- |
| Central ID long poll | 40 seconds for a 30-second poll |
| Remote MCP connect | 5 seconds |
| Remote MCP tool call | 30 seconds unless the approved tool contract is shorter |
| Webhook wake | 10 seconds |
| Local MCP request | 35 seconds |

Production limits must be positive constants, tested at and above their boundaries, and not user-configurable in v1.

## Data boundary

Never write task text, prompts, attachments, responses, results, permission details, grants, tool arguments, email addresses, verification codes, webhook tokens, plaintext central JWTs, or MCP request and response bodies to configuration, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles. The upstream MCP request may contain the injected JWT transiently in memory; no retry spool or body capture is allowed.

The approved credential store is the sole durable exception for the central JWT. If ADR 0019 approves encrypted-file storage, only authenticated ciphertext and its cryptographic metadata may be written.

## Acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| C01 | Start with both named `--name=value` options | Bind MCP, print endpoint, and wait |
| C02 | Use split options, positionals, agent IDs, setup, or config flags | Reject with no listener or remote request |
| C03 | Missing or invalid token environment | Reject without exposing the value |
| C04 | Second process starts | Fail before credential access, MCP bind, poll, or webhook |
| M01 | Missing or wrong local bearer | Reject before parsing or forwarding MCP |
| M02 | Unexpected `Host` or `Origin` | Reject before tool execution |
| M03 | Bootstrap tool before enrollment | Forward without a central JWT argument |
| M04 | Authenticated tool before enrollment | Reject locally without forwarding |
| M05 | Authenticated local tool after enrollment | Local schema/result contain no token; upstream arguments contain the stored JWT exactly once |
| M06 | Verification completes in an active MCP session | Emit tool-list change; the next list contains authenticated tools and no bootstrap tools |
| V01 | Valid verification result | Persist JWT, return token-free result, enable tools and polling |
| V02 | Credential persistence fails | Return failure, expose no JWT, and do not enable polling |
| V03 | JWT appears in an unexpected result shape | Fail closed and persist nothing |
| V04 | Verification tries to replace an identity | Reject without changing the stored JWT |
| P01 | Valid ID notification | Store the ID before waking |
| P02 | Poll response contains content or unknown fields | Reject and store nothing |
| P03 | Restart before remote acknowledgement | Poll and wake the same ID again |
| P04 | Crash after ID commit before notification acknowledgement | Resend `ack_notification` without losing the wake |
| P05 | Repeated `ack_notification` | Central service returns success and leaves content available to MCP |
| W01 | Valid webhook wake | Send fixed body, bearer token, and ID idempotency key |
| W02 | Uncertain webhook outcome | Retry the same ID, never a new one |
| A01 | Agent acknowledges through MCP | Forward with injected JWT and mark local ID terminal after confirmation |
| A02 | Notification was acknowledged before agent MCP poll | MCP still returns the full message content |
| S01 | Inspect files, SQLite, output, logs, diagnostics, and errors | Find no forbidden plaintext or MCP body data |
| S02 | Side-effecting upstream call times out | Do not retry automatically |
