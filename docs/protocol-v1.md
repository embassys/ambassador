# Gateway protocol

Status: accepted current development contract as of 2026-09-02

ADR 0037 replaces the earlier bearer-only and proposed versioned central
contracts. This document defines one gateway behavior for the current REST
server. It makes no compatibility or migration promise.

## Startup contract

The public command is:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

Both named options are required exactly once in `--name=value` form. Positional
values, unknown options, literal-token options, endpoint options, setup
options, runtime selectors, binding IDs, configuration paths, and verbose
transcript options are rejected.

`--webhook-url` accepts a literal-loopback URL with an explicit port and no
credentials or fragment. `--webhook-token-env` names an environment variable
matching `[A-Za-z_][A-Za-z0-9_]*`. Its value must contain exactly 192 random
bits encoded as 48 lowercase hexadecimal characters.

The process acquires its singleton lock before reading credentials, binding a
listener, calling central, or sending a webhook. It binds
`127.0.0.1:8787` and prints this line after the endpoint is ready:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

`SIGINT` and `SIGTERM` stop new work, cancel the central poll, allow bounded
in-flight work to settle, close the listener and journal, and release the
lock.

## Local MCP boundary

Every local MCP request uses Streamable HTTP at `/mcp` and sends:

```http
Authorization: Bearer <resolved-webhook-token>
```

The gateway requires `Host: 127.0.0.1:8787`. A present `Origin` must be exactly
`http://127.0.0.1:8787`. Authentication and these origin checks happen before
body parsing.

The existing limits remain:

| Boundary | Limit |
| --- | --- |
| Request headers | 16 KiB |
| Local MCP request body | 1 MiB |
| Local or upstream response body | 4 MiB |
| Active MCP sessions | 32 |
| Concurrent tool calls | 8 |
| Serialized structured tool result | 512 KiB |

JSON-RPC batches are rejected. Redirects are rejected. Errors do not reflect
request bodies, remote bodies, URLs, headers, or credentials.

## Central origin

The current central REST origin is fixed:

```text
https://mcp.embassys.ai
```

Production code has no central MCP URL and no API-version selector. Test
harnesses may inject a local REST origin through an internal seam. That seam is
not a CLI option, user configuration, fallback, or production discovery
mechanism.

## Tool catalog

Before enrollment, expose exactly:

- `register_agent`
- `verify_email`
- `resend_verification`

After a credential is durably stored, expose these REST-backed tools:

- `list_action_types`
- `request_permission`
- `respond_to_permission`
- `call_action`
- `poll_messages`
- `get_my_permissions`
- `ack_message`

The gateway owns these tool schemas. It does not fetch or mirror a central MCP
catalog. `list_action_types` returns the server's dynamic action names and
payload schemas; those action definitions are data returned by a REST tool,
not new gateway tools.

Every local tool call still requires local MCP authentication. Reject any
local argument named `token`, `jwt`, `access_token`, `authorization`,
`private_key`, `proof`, or `dpop` before central dispatch. Reject an upstream
result containing those credential fields or the stored token bytes.

## Enrollment REST contract

### `register_agent`

Local input and central body:

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name"
}
```

`display_name` may be omitted. There is no username field. The central request
is `POST /api/register_agent` with `Content-Type: application/json` and no
central authorization header.

The successful central response contains `agent_id`, `email`, and `message`.
The gateway returns those fields after its general credential-field scan.

### `resend_verification`

Local input and central body:

```json
{"email":"agent@example.test"}
```

The central request is `POST /api/resend_verification` with no central access
token. A successful response contains a `message`.

### `verify_email`

Local input:

```json
{
  "email": "agent@example.test",
  "code": "123456"
}
```

The gateway serializes verification attempts. It generates one P-256 key pair
for the attempt and sends:

```json
{
  "email": "agent@example.test",
  "code": "123456",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url-x-coordinate",
    "y": "base64url-y-coordinate"
  }
}
```

The request is `POST /api/verify_email` with no central access token or DPoP
proof. A successful response has `Cache-Control: no-store` and this shape:

```json
{
  "agent_id": "opaque-agent-id",
  "email": "agent@example.test",
  "token": "compact-jwt",
  "jkt": "public-key-thumbprint",
  "message": "Email verified successfully. Store this token securely - it will not be shown again."
}
```

The gateway intercepts `token` before generic result serialization. It checks:

- the token is a bounded three-segment compact JWT;
- the payload contains string `sub` and `email`, numeric `iat` and `exp`, and
  `cnf.jkt`;
- `exp` is later than the current time and later than `iat`;
- the payload thumbprint matches the generated public key;
- a present response `jkt` matches the same key; and
- the response identity matches the requested email.

The central token uses an HS256 server signature that the client cannot
verify. The gateway does not invent issuer, audience, token ID, token type, or
24-hour lifetime requirements that are absent from the server.

The token and PKCS#8 private key are written as one atomic encrypted
credential using ADR 0019's Node-core AES-256-GCM store. The exact internal
format is current-only. No old credential reader or migration path is kept.

Only after persistence succeeds does the gateway enable protected tools and
return:

```json
{
  "verified": true,
  "agent_id": "opaque-agent-id",
  "email": "agent@example.test",
  "message": "Email verified successfully."
}
```

The token, public thumbprint, and key never appear in the local result. If
persistence fails after remote verification, the gateway reports an uncertain
failure and does not return the credential.

## DPoP request contract

Every protected REST request sends:

```http
Authorization: Bearer <central-token>
DPoP: <proof-jwt>
```

The authorization scheme is `Bearer`. `Authorization: DPoP` is not supported
by the server.

The proof is signed with ES256 by the credential's P-256 key. Its protected
header is:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {"kty":"EC","crv":"P-256","x":"...","y":"..."}
}
```

Its payload contains:

```json
{
  "jti": "unique-per-proof-value",
  "htm": "GET",
  "htu": "https://mcp.embassys.ai/api/poll_messages?timeout=30",
  "iat": 1788220800,
  "ath": "base64url-sha256-of-access-token"
}
```

`htm` is the exact uppercase method. `htu` is the exact request URL seen by the
client, including the query string and its order. A proof is never reused.

If a `401` contains one valid `DPoP-Nonce` value, cache it for the REST origin
and repeat the same operation once with a new `jti`, current `iat`, and the
nonce claim. The first request does not proactively include a nonce. Invalid,
duplicate, or repeated challenges fail closed. Any other `401`, wrong-key
response, expired credential, proof failure, or replay response disables that
operation and does not trigger registration, token replacement, or a
bearer-only retry.

## Protected REST tools

All request bodies are JSON. The following fields are the current source
contract.

| Tool | Method and path | Input |
| --- | --- | --- |
| `list_action_types` | `GET /api/list_action_types` | none |
| `request_permission` | `POST /api/request_permission` | `target_email`, `action_type`, optional `scope` object |
| `respond_to_permission` | `POST /api/respond_to_permission` | `permission_id`, `decision` equal to `granted` or `denied` |
| `call_action` | `POST /api/call_action` | `target_email`, `action_type`, `payload` object |
| `poll_messages` | `GET /api/poll_messages?timeout=<0..60>` | optional `timeout`; gateway background poll uses 30 |
| `get_my_permissions` | `GET /api/get_my_permissions` | none |
| `ack_message` | `POST /api/ack_message` | `message_id` |

`call_action` delivers a request to another agent after central confirms a
granted permission. It does not execute the action. The gateway does not add a
free-text reply, completion, outcome, conversation, activation, or reissue
tool because the server has no such REST route.

The deployed action catalog defines the exact action names and their payload
schemas. The pinned catalog includes `get_email` and `get_phone_number`; each
accepts an object with required string `reason`. Their `reason` properties
also carry the deployed descriptions recorded in the fixture inventory.

## Message polling and local retrieval

The gateway holds one long poll:

```http
GET /api/poll_messages?timeout=30
Authorization: Bearer <central-token>
DPoP: <fresh-proof>
```

The response is an object with a `messages` array. Current source returns each
message with `id`, `sender_agent_id`, optional `action_type_id`, `payload`, and
`created_at`. The server changes each selected row from `queued` to
`delivered` in the same database statement that returns it.

Before accepting a batch, the gateway enforces the existing 4 MiB response,
100-level nesting, 16,384 structural-token, 256-message, and 512 KiB normalized
local-result limits. A present message ID must be a bounded opaque string.
Conflicting duplicate IDs reject the batch.

Message bodies remain only in the bounded in-memory inbox. SQLite stores only
present IDs and relay state. Background central polling pauses while the inbox
contains work.

The local `poll_messages` tool reads that inbox without another central
request. ID-bearing messages remain available until acknowledgement. An
ID-less message is returned once and is never sent to `ack_message`.

For an ID-bearing message, local `ack_message` forwards exactly one protected
REST request. Only a response with the matching `message_id` and
`status: "acked"` removes the body and journal row. A failed or uncertain
acknowledgement is not retried automatically because the current server treats
a repeat as not found.

The server has no lease or delivered-message retrieval. A crash clears the
in-memory inbox. Startup removes stale wake rows whose bodies cannot be
recovered. This can lose a delivered message and is an accepted development
limitation.

## Webhook wake

The gateway sends the existing ID-only webhook:

```http
POST <webhook-url>
Authorization: Bearer <resolved-webhook-token>
Idempotency-Key: <message-id>
X-Request-ID: <message-id>
X-Webhook-Timestamp: <current-Unix-seconds>
X-Webhook-Signature-V2: <hex-HMAC-SHA256>
Content-Type: application/json
```

The HMAC covers the ASCII timestamp, one `.` byte, and the exact request body.
The body tells the webhook owner that an A2A message is ready and includes only
the opaque message ID. A `2xx` response means the webhook accepted the wake.
It does not mean the message was processed.

Failed or uncertain wakes retry the same ID with a fresh timestamp and
signature. Accepted wakes may be repeated while the corresponding in-memory
message remains unacknowledged.

## Errors, deadlines, and retries

The central service normally returns JSON with a `detail` member on error. The
gateway consumes at most its response limit and maps the status to a stable,
credential-free local error. It never forwards the remote body verbatim.

| Operation | Deadline |
| --- | --- |
| Registration, verification, resend, and protected REST call | 30 seconds |
| Central long poll | 40 seconds for a 30-second server hold |
| Local MCP request | 35 seconds |
| Webhook wake | 10 seconds |

No client follows a central redirect. No side-effecting call is retried after
an uncertain outcome. The optional one-time DPoP nonce response is the only
authentication retry.

## Data boundary

Never write message bodies, action payloads, permission details, MCP arguments
or results, registration emails, verification codes, tokens, private keys,
proofs, nonces, remote response bodies, or webhook secrets to SQLite,
configuration, normal logs, diagnostics, metrics, temporary files, crash
artifacts, or support bundles.

The encrypted credential contains only the central token and DPoP private key
plus the minimum format metadata needed to decrypt and validate them. The
notification journal remains ID-only.

## Acceptance cases

The current integration must prove at least:

- bootstrap REST paths and email-only request shapes;
- token interception and token-free local verification results;
- key binding between the submitted JWK, response `jkt`, token `cnf.jkt`, and
  stored private key;
- `Authorization: Bearer` plus a separate proof on every protected request;
- rejection of missing proofs, wrong keys, stale proofs, future proofs, wrong
  method or URL, wrong token hash, and replayed `jti` values;
- optional nonce retry only when the server supplies a nonce;
- no central MCP traffic or token argument;
- fixed permission, action, poll, permission-list, and acknowledgement REST
  shapes;
- bounded in-memory message custody and ID-only durable state;
- honest restart-loss behavior for a consumed message;
- no old credential, central MCP fallback, `/api/v2`, reissue, activation,
  lease, conversation, or migration path in the built artifact; and
- no credential or content in logs, databases, temporary files, packages, or
  test output.
