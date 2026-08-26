# Gateway protocol v1

Status: accepted for the single-webhook design on 2026-08-25; dual webhook authentication accepted on 2026-08-26

## Startup contract

The public command is:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

Both options are required exactly once. The CLI accepts only the `--name=value` form. It rejects positional values, literal-token options, unknown options, setup options, configured local-runtime agent IDs, binding IDs, and configuration paths.

The `0.2.1` development flow reads a paired endpoint override from `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL`. These values do not add CLI options. Set both for a working development flow. Remote values require HTTPS; plain HTTP is accepted only for `127.0.0.1`, `[::1]`, or `localhost`. URL credentials, queries, fragments, whitespace, and line breaks are rejected. Stable production endpoints remain product constants once chosen.

`--webhook-url` requires `http://127.0.0.1:<port>/...` or `https://127.0.0.1:<port>/...`, without URL credentials or fragments. Hostnames, non-loopback IP addresses, and an omitted port are rejected. Restricting the destination to a literal loopback address prevents disclosure of the bearer that also authenticates local MCP. `--webhook-token-env` accepts an environment-variable name matching `[A-Za-z_][A-Za-z0-9_]*`; the resolved value must contain exactly 192 random bits in `[0-9a-f]{48}` format.

Invalid command syntax or option values exit `2`. A missing, empty, or line-breaking resolved webhook token exits `4`. Singleton and local state failures exit `7`. Errors never echo an option value, environment value, URL, header, or remote body.

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

Missing, malformed, or incorrect authorization returns `401` before parsing or forwarding the MCP body. Authentication uses a timing-safe comparison. MCP session IDs do not authenticate a request.

The server requires `Host: 127.0.0.1:8787`; another value returns `421`. It accepts a missing `Origin` header; when `Origin` is present, it must be exactly `http://127.0.0.1:8787`, otherwise the request returns `403`. These checks and bearer authentication happen before body parsing.

The listener permits at most 16 KiB of request headers, a 1 MiB request body, a 4 MiB local or upstream response body, 32 active MCP sessions, and 8 concurrent tool calls. A limit violation rejects the request without reflecting its body. It rejects redirects and does not follow upstream-provided URLs.

## Tool catalog

Before enrollment, expose only:

- `register_agent`
- `verify_email`
- `resend_verification`

These tools are exempt from central JWT injection, not from local bearer authentication. Their arguments and results pass through memory only.

After enrollment, remove the bootstrap tools and expose this allowlist when the upstream server advertises each tool:

- `list_action_types`
- `request_permission`
- `respond_to_permission`
- `call_action`
- `poll_messages`
- `get_my_permissions`
- `ack_message`
- `health_check`

Advertise MCP tool-list change support and send `notifications/tools/list_changed` after the JWT is durably stored. Remove the upstream `token` property from every local input schema. Reject local calls containing `token`, `jwt`, a credential selector, or an identity selector. When an allowlisted upstream tool schema contains the central server's required `token` argument, add `token: <central-agent-jwt>` only to that transient upstream `tools/call`. Do not add it to `health_check`, whose upstream schema has no token.

Before returning any upstream result, reject it if any nested field is named `token`, `jwt`, `access_token`, or `authorization`, or if its serialization contains the stored JWT bytes. Apply the same rule to bootstrap and authenticated tools. Never pass upstream error text to the local caller.

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

After the ID commit, notification acknowledgement and webhook wake proceed independently. A delayed or failed `ack_notification` does not block the first wake; its ID-only outbox retries until the central service confirms it.

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

An exact repeated ID is coalesced. One wake attempt per ID runs at a time. The gateway records an attempt before sending the webhook. A failed or uncertain attempt retries the same ID with equal jitter between half and all of an exponential delay with a one-second base and 60-second cap. An accepted wake is re-driven after 60 seconds while content remains unacknowledged. There is no attempt-count terminal state; successful `ack_message` is terminal.

## Webhook wake

The gateway sends:

```http
POST <webhook-url>
Authorization: Bearer <resolved-webhook-token>
Idempotency-Key: <message-id>
X-Request-ID: <message-id>
X-Webhook-Timestamp: <current Unix time in seconds>
X-Webhook-Signature-V2: <lowercase hexadecimal HMAC-SHA256 signature>
Content-Type: application/json
```

The signature key is the resolved webhook token. Its signed bytes are the ASCII timestamp, one `.` byte, and the exact UTF-8 request body. The gateway generates a new timestamp and signature for every attempt. It always sends both authentication formats without selecting or identifying a local runtime: bearer-aware webhooks use `Authorization`, while HMAC V2 webhooks use the timestamp and signature. `Idempotency-Key` and `X-Request-ID` carry the same opaque message ID.

The body is:

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

The local agent calls `poll_messages` through the gateway after waking. The gateway injects the central JWT and the central MCP server returns the full message. That content never enters the relay journal. Polling content does not consume it: the central MCP server returns it again after a disconnect or agent crash until `ack_message` succeeds.

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

The approved credential store is the sole durable exception for the central JWT. Only authenticated ciphertext and the cryptographic metadata defined by ADR 0019 may be written.

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
| W01 | Valid webhook wake | Send the fixed body, bearer token, valid HMAC V2 headers, and the same ID in both deduplication headers |
| W02 | Uncertain webhook outcome | Retry the same ID and body with a fresh timestamp and signature, never a new ID |
| A01 | Agent acknowledges through MCP | Forward with injected JWT and mark local ID terminal after confirmation |
| A02 | Notification was acknowledged before agent MCP poll | MCP still returns the full message content |
| A03 | Agent crashes after content poll before `ack_message` | Content remains retrievable and the gateway re-drives the same wake ID |
| S01 | Inspect files, SQLite, output, logs, diagnostics, and errors | Find no forbidden plaintext or MCP body data |
| S02 | Side-effecting upstream call times out | Do not retry automatically |
