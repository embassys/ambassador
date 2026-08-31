# Gateway protocol v1 and accepted v2 target

Status: accepted for the single-webhook design on 2026-08-25; dual webhook authentication and bounded central-result normalization accepted on 2026-08-26; live consuming notification compatibility, relay amplification limits, and a 404-only MCP polling fallback accepted on 2026-08-27; REST bootstrap, DPoP transport, version 2 credentials, lease redelivery, and the REST v2 message lifecycle accepted as the next contract on 2026-08-29

This document records two implementation states. Sections labeled `0.2.6`
describe the shipped compatibility behavior. The accepted next contract below
supersedes that behavior as the implementation target. It does not claim that
the production central service already implements the target or that stable
production endpoint values are known.

The project owner reports that the central server has a DPoP implementation,
but the inspected `embassys/agent2agent` default branch and hosted routes still
show the older bearer contract. The exact DPoP revision and deployment must be
pinned and tested through I01 and I02 before this repository claims live
compatibility. See [server integration status](server-integration-status.md).

## Startup contract

The public command is:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The webhook URL and token environment options are required exactly once. The CLI accepts only the `--name=value` form. It also accepts `--verbose=true` once as a temporary development diagnostic when the paired development central endpoints are present. It rejects `--verbose`, other verbose values, positional values, literal-token options, unknown options, setup options, configured local-runtime agent IDs, binding IDs, and configuration paths.

The `0.2.6` development flow reads a paired endpoint override from `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL`. These values do not add CLI options. Set both for a working development flow. Remote values require HTTPS; plain HTTP is accepted only for `127.0.0.1`, `[::1]`, or `localhost`. URL credentials, queries, fragments, whitespace, and line breaks are rejected. Stable production endpoints remain product constants once chosen.

`--webhook-url` requires `http://127.0.0.1:<port>/...` or `https://127.0.0.1:<port>/...`, without URL credentials or fragments. Hostnames, non-loopback IP addresses, and an omitted port are rejected. Restricting the destination to a literal loopback address prevents disclosure of the bearer that also authenticates local MCP. `--webhook-token-env` accepts an environment-variable name matching `[A-Za-z_][A-Za-z0-9_]*`; the resolved value must contain exactly 192 random bits in `[0-9a-f]{48}` format.

Invalid command syntax or option values exit `2`. A missing, empty, or line-breaking resolved webhook token exits `4`. Singleton and local state failures exit `7`. Normal errors never echo an option value, environment value, URL, header, or remote body.

With `--verbose=true`, the gateway writes request and response transcripts to stderr. It redacts bearer credentials, credential-named fields, cookie and webhook-signature headers, and verification codes. Other MCP arguments, results, emails, messages, actions, and permission data may appear. The gateway never creates a transcript file. This temporary exception applies only to the paired development endpoints and is tracked for removal in `docs/development-todos.md`.

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

The listener permits at most 16 KiB of request headers, a 1 MiB request body, a 4 MiB local or upstream response body, 32 active MCP sessions, and 8 concurrent tool calls. It rejects JSON-RPC batches before dispatch because multiple side-effecting results cannot safely share the fixed response budget. Before the MCP SDK creates its structured result and escaped text mirror, the gateway limits the serialized tool result to 512 KiB. This leaves room for both copies and a maximum-size request ID under the 4 MiB transport cap. A limit violation rejects the request without reflecting its body. The listener rejects redirects and does not follow upstream-provided URLs.

## `0.2.6` tool catalog and central dispatch

Before enrollment, expose only:

- `register_agent`
- `verify_email`
- `resend_verification`

These tools are exempt from central JWT injection, not from local bearer authentication. Their arguments and results pass through memory only.

For each selected tool, use the description and input schema advertised by the central MCP server. Keep only the allowlisted tool fields and remove forbidden credential and identity selectors before exposing the definition locally.

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

### Central result normalization

The development central MCP wrapper may return one exact mirrored string result: `structuredContent` contains only `result: string`, and `content` contains one text item with the same string. Normalize that string when it is either valid JSON or the bounded Python-literal subset defined below:

- dictionaries with unique string keys;
- lists;
- quoted strings with explicit escapes;
- finite JSON-compatible numbers; and
- `True`, `False`, and `None`.

The parser is data-only. It selects one grammar for the complete value and rejects mixed JSON and Python syntax. It does not evaluate code and does not accept names, calls, attributes, bytes, sets, tuples, comprehensions, comments, or duplicate keys. The existing 4 MiB response limit and 100-level nesting limit apply before nested values are allocated. A normalized top-level object replaces the wrapper. A normalized array or scalar remains under `{result: value}` so local MCP `structuredContent` stays object-shaped. Failed parses containing collection delimiters, call syntax, a comment prefix, or a quoted-literal prefix fail closed; other plain strings remain ordinary `{result: string}` results and therefore fail any stricter tool-specific contract. Every normalized result still passes the existing credential and tool-specific checks. The gateway validates result and mirrored-content `_meta` as plain objects and rejects forbidden credential names, stored credential bytes, and newly issued verification credential bytes before discarding the metadata.

## `0.2.6` verification and JWT custody

A successful upstream `verify_email` result, after the bounded normalization above, must contain these fields:

```json
{
  "agent_id": "agent_123",
  "username": "nik-agent",
  "token": "central-jwt",
  "message": "Email verified successfully.",
  "note": "The gateway owns the issued credential."
}
```

`note` illustrates an optional extension. The gateway accepts and discards additional fields after recursively rejecting credential field names and any value containing the issued token. It still requires the four fields it uses and exactly one parsed `token` key.

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

## `0.2.6` notification API

After enrollment, the gateway sends the live central API's JWT-authenticated long poll:

```text
GET /api/poll_messages?timeout=30
Authorization: Bearer <central-agent-jwt>
```

The response contains full queued messages. A representative action message is:

```json
{
  "messages": [
    {
      "id": "0f56d6f4-6073-4f75-9f31-72d7d760271a",
      "sender_agent_id": "agent_123",
      "action_type_id": "action_456",
      "payload": {"date": "2026-08-27"},
      "created_at": "2026-08-27T12:00:00Z"
    }
  ]
}
```

If and only if the REST poll returns HTTP `404`, the gateway cancels that response body and switches to the central MCP `poll_messages` tool for the rest of the process lifetime. It injects the stored JWT as the transient `token` argument and requests a 20-second poll so the operation completes inside the 30-second MCP deadline. A timeout, connection failure, redirect, or any non-404 status does not trigger MCP polling because the REST outcome may be uncertain. MCP results pass through the approved bounded result normalization and then the same notification validation and limits as REST results.

After switching, retryable MCP connection and request failures stay on MCP. An MCP authentication failure disables authenticated work. A redirect, invalid result, credential-bearing result, or oversized result stops the gateway rather than retrying a deterministic contract failure after a consuming call.

The central service atomically marks messages returned through either interface delivered. They are no longer available from a later central REST or MCP `poll_messages` call. The API has no separate `ack_notification` operation.

The gateway reads at most 4 MiB. Before `JSON.parse`, it rejects more than 100 container levels or 16,384 structural tokens. It then requires an exact top-level `messages` array with at most 256 JSON objects and at most 512 KiB when normalized as the local `poll_messages` result. These limits apply before journal changes, wake creation, or inbox insertion. A present `id` must be a string containing 1 to 128 URI-unreserved ASCII characters. An absent ID is valid; a present invalid ID rejects the response. Duplicate IDs with conflicting bodies reject the complete response.

The validated messages remain in process memory only. The gateway pauses central polling while the inbox is nonempty or an ID-less wake still needs webhook acceptance. This bounds the inbox and volatile wake state to one response. It stores only present IDs and wake state in SQLite. It never writes message bodies to SQLite, files, output, logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles.

## `0.2.6` durable relay

SQLite stores only:

- schema version;
- notification ID;
- delivery state;
- attempt count and next attempt time;
- whether a wake may have reached the webhook.

SQLite contains no binding, cursor, webhook URL, webhook token, central JWT, MCP argument, MCP result, registration data, or task content.

The replacement uses new `a2a-gateway` state directories and does not read the legacy `a2a-sidecar` configuration or journal. It leaves legacy files untouched; no shipped central integration depends on migrating them.

An exact repeated ID with an identical body is coalesced while active. One wake attempt per ID runs at a time. The gateway records an attempt before sending the webhook. A failed or uncertain attempt retries the same ID with equal jitter between half and all of an exponential delay with a one-second base and 60-second cap. An accepted ID-bearing wake is re-driven after 60 seconds while content remains unacknowledged. There is no attempt-count terminal state; successful `ack_message` is terminal.

Each ID-less message is a separate volatile observation, including two structurally identical messages in one response. It receives a random process-local wake key for webhook retry headers but is not written to the journal. Its wake retries until accepted, including when a local poll returns the body before an in-flight wake finishes. The wake is not re-driven after acceptance, and the body is removed after the first local `poll_messages` result. It is never sent to `ack_message`.

Because the central API cannot re-fetch delivered messages and bodies cannot be persisted, a gateway stop or crash with a nonempty inbox loses those bodies. At startup the gateway deletes every journal row because none has a recoverable in-memory body, preventing stale wakes. Central redelivery or delivered-message retrieval is required for durable recovery.

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

For an ID-bearing message, the body is:

```json
{
  "message": "A2A message <message-id> is ready. Use the A2A MCP tools to retrieve and process it.",
  "name": "A2A Gateway",
  "deliver": false,
  "wakeMode": "now"
}
```

The body omits `agentId`, so the webhook owner chooses its default target. The message ID is the only variable content. A `2xx` response means the webhook accepted the wake, not that the agent completed the work.

For an ID-less message, the body uses the generic instruction `An A2A message is ready. Use the A2A MCP tools to retrieve and process it.` The random wake key appears only in `Idempotency-Key` and `X-Request-ID`; it is not added to the central message or passed to `ack_message`.

## `0.2.6` MCP message retrieval and acknowledgement

The local agent calls `poll_messages` through the gateway after waking. The gateway validates the local arguments and serves its in-memory inbox without another central request. A later central outage therefore cannot hide content already buffered by the gateway. ID-bearing messages remain visible on repeated local polls until acknowledged. ID-less messages appear once and are then removed. A positive timeout waits for in-memory work for at most 30 seconds; zero returns immediately.

The local agent calls `ack_message` after processing an ID-bearing message. The gateway forwards it once with the central JWT. A successful live response has exactly `{"message_id":"...","status":"acked"}`. Only then does the gateway delete the durable ID, stop accepted-wake redelivery, and remove the in-memory body. An uncertain or failed acknowledgement leaves the body available locally; the gateway does not retry the side-effecting call automatically.

## Accepted next contract

ADRs 0023, 0025, and 0026 replace the following `0.2.6` rules:

- Bootstrap no longer uses central MCP. The gateway owns the local bootstrap
  schemas and sends fixed REST requests to `/api/register`,
  `/api/verify_email`, and `/api/resend_verification`.
- Verification is no longer the only possible token response. It creates the
  first credential, scheduled `/api/v2/token/reissue` may return a same-key
  replacement, and email-control verification may return a same-identity
  replacement bound to a new key after central revokes the old tokens.
- Protected central MCP no longer carries a `token` tool argument. Every
  protected central REST and MCP HTTP request carries `Authorization: DPoP`
  and a fresh proof.
- Consuming poll and its crash-loss behavior are no longer the delivery target.
  The gateway uses the fixed REST v2 lifecycle, and central redelivers the same
  immutable unacknowledged message after a 60-second lease expires.

These changes ship as one coordinated contract. The gateway must not generate
proofs for a service that still accepts the same DPoP-bound token through a
bearer path.

### REST bootstrap

The local catalog before enrollment contains exactly `register_agent`,
`verify_email`, and `resend_verification`. Every call still requires local MCP
authentication before body parsing. The gateway projects the accepted local
schema and sends one bounded request:

| Local tool | Central request | Central access token |
| --- | --- | --- |
| `register_agent` | `POST /api/register` | None |
| `verify_email` | `POST /api/verify_email` | None; request carries a DPoP issuance proof |
| `resend_verification` | `POST /api/resend_verification` | None |

The gateway uses one fixed central API base. It does not probe
`/api/register_agent`, fall back to central MCP, follow a redirect, or retry an
uncertain outcome. One valid nonce challenge may repeat verification once with
the same attempt key and a fresh proof. ADR 0023 fixes the request and response
projection, safe errors, parsing limits, and token-free local results.

### DPoP credential and protected transport

Immediately before verification, the gateway creates one P-256 key pair. A
successful response must contain `token_type: "DPoP"`, `expires_in: 86400`, and
a JWT whose `cnf.jkt` matches that key. The gateway intercepts the token before
generic result handling and persists this exact plaintext record inside the
ADR 0019 encrypted envelope:

```json
{
  "credential_version": 2,
  "token_type": "DPoP",
  "access_token": "<central-jwt>",
  "dpop_alg": "ES256",
  "dpop_private_key_pkcs8": "<base64url-pkcs8-der>"
}
```

The gateway enables no protected work until it has validated and durably
published the complete record. Every protected central REST and Streamable
HTTP MCP request then sends:

```text
Authorization: DPoP <central-jwt>
DPoP: <fresh-proof>
```

The proof follows ADR 0026 and binds the request method, normalized external
URI, access-token hash, time, nonce, and one-use ID to the stored P-256 key.
Central MCP tool schemas and arguments contain no token. A session ID does not
authenticate a later MCP HTTP request.

The 24-hour token enters scheduled same-key reissue with 12 hours remaining.
Reissue may replace the encrypted record only when the issuer, subject,
ordered audience, signing algorithm, key binding, proof algorithm, endpoint
pair, and lifetime pass the ADR 0026 comparison. The gateway may repeat that
one operation with its existing idempotency key after an uncertain outcome.

Key loss, expiry, revocation, and deliberate key rotation require fresh
email-control verification and a new P-256 key. The future version 2 release
is a fresh-install cutover and does not convert a version 1 credential. A
`401`, invalid token, proof failure, key failure, or ordinary tool error never
triggers token refresh, reissue, recovery, registration, deletion, or bearer
fallback. An unreadable record remains untouched until the project approves
an explicit local reset interface.

### REST v2 message lifecycle

After a version 2 credential is durable, the gateway calls the monotonic
`POST /api/v2/delivery/activate` operation. It starts no receive loop until it
has observed the exact `active` result. The release selects this contract at
build and review time. The gateway does not discover capabilities, infer a
version, probe another route, or fall back to central MCP.

The gateway uses these fixed central REST operations:

| Purpose | Request |
| --- | --- |
| Start a conversation | `POST /api/v2/conversations` |
| Resolve an uncertain start | `GET /api/v2/conversation-starts/{request_id}` |
| Receive leased messages | `GET /api/v2/messages/receive?timeout=30&limit=100` |
| Reply | `POST /api/v2/messages/{message_id}/reply` |
| Record a no-reply outcome | `POST /api/v2/messages/{message_id}/complete` |
| Inspect the outcome | `GET /api/v2/messages/{message_id}/outcome` |
| Acknowledge | `POST /api/v2/messages/{message_id}/ack` |

Version 2 supports strict text-only `conversation_turn` messages in one linear
conversation. Central generates message and conversation IDs. It derives reply
routing from the authenticated recipient and immutable inbound message, not
from caller-supplied identity or routing fields. Starts, replies, completions,
and acknowledgements use the idempotency rules in ADR 0025.

Receive leases the oldest bounded batch for 60 seconds. Central retains each
immutable body until the recipient records a terminal reply or completion and
acknowledges it. Lease expiry makes an unacknowledged message eligible again.
The gateway keeps bodies only in bounded memory and persists only opaque IDs
and relay state. On restart it clears stale wake rows and waits for central
redelivery.

The local `poll_messages` tool serves only the current in-memory inbox. A
caller must record a reply or terminal no-reply outcome before acknowledgement.
The gateway removes the body and journal row only after the exact `acked`
result. It never replays a provider prompt to resolve an uncertain side effect.

### Deployment status

The accepted test-only [version 2 fixture profile](v2-fixture-profile.md)
supplies deterministic defaults for fixtures and red tests. It does not supply
production hostnames, signing keys, proxy trust, capacity, or evidence of
central deployment. Development endpoint overrides and fixture values remain
non-production inputs. A release cannot claim central interoperability until
the deployment owners provide and stage those facts.

The central repository location is known, and DPoP is reported implemented.
That report does not identify the source commit or prove which contract the
hosted service runs. I01 refreshes the gateway integrations and tests against
one pinned latest server revision. I02 then runs a fresh-identity DPoP
development E2E with bearer rejection. Neither task changes the protocol in
this document without ADR review.

## Deadlines and limits

| Operation | Deadline |
| --- | --- |
| `0.2.6` central REST consuming message poll | 40 seconds for a 30-second poll |
| Accepted v2 central REST leased receive | 40 seconds for a 30-second receive |
| `0.2.6` central MCP consuming message fallback | 30 seconds for a 20-second poll |
| Remote MCP connect | 5 seconds |
| Remote MCP tool call | 30 seconds unless the approved tool contract is shorter |
| Webhook wake | 10 seconds |
| Local MCP request | 35 seconds |

Production limits must be positive constants, tested at and above their boundaries, and not user-configurable in either accepted contract.

## Data boundary

Never write task text, prompts, attachments, responses, results, permission details, grants, tool arguments, email addresses, verification codes, webhook tokens, plaintext central JWTs, DPoP private keys, proofs, nonces, or MCP request and response bodies to configuration, SQLite, normal logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles. In `0.2.6`, an upstream MCP request may contain the injected JWT transiently in memory. The accepted next contract removes that exception. A DPoP-bound token may appear transiently only in a gateway-to-central `Authorization: DPoP` header or while calculating `ath`; no retry spool or body capture is allowed.

ADR 0022 temporarily permits `--verbose=true` to print development request and response transcripts to stderr. It may print the non-credential data listed above. It must redact webhook and central credentials, credential-named fields, cookie and webhook-signature headers, and verification codes. This exception does not permit transcript files or automatic body capture outside the foreground stderr stream.

The approved credential store is the sole durable exception for the central token and DPoP private key. Only authenticated ciphertext and the cryptographic metadata defined by ADRs 0019 and 0026 may be written.

## `0.2.6` acceptance cases

| ID | Case | Expected result |
| --- | --- | --- |
| C01 | Start with both named `--name=value` options | Bind MCP, print endpoint, and wait |
| C02 | Use split options, positionals, agent IDs, setup, or config flags | Reject with no listener or remote request |
| C03 | Missing or invalid token environment | Reject without exposing the value |
| C04 | Second process starts | Fail before credential access, MCP bind, poll, or webhook |
| C05 | Start with `--verbose=true` and paired development endpoints | Print redacted request and response transcripts to stderr |
| C06 | Use verbose mode without paired development endpoints or use another verbose form | Reject before binding or making a remote request |
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
| P01 | Valid full message with an ID | Keep the body in memory, store only the ID, then wake |
| P02 | Poll response is malformed, credential-bearing, exceeds byte/depth/structure/count limits, or has conflicting duplicate IDs | Reject and store nothing |
| P03 | Two ID-less messages have identical bodies | Treat both as unique, wake both, return both once, journal neither |
| P04 | Poll while an ID-bearing message is buffered | Return it again without another central poll |
| P05 | Restart with a nonterminal durable wake but no body | Delete the stale row and do not wake |
| P06 | ID-less body is polled before an in-flight wake fails | Return it once and keep retrying the same volatile wake key until acceptance |
| P07 | REST notification poll returns explicit `404` | Switch permanently for that process to bounded MCP `poll_messages` with the injected JWT |
| P08 | REST notification poll has any other failed or uncertain outcome | Do not call MCP `poll_messages`; retry REST only |
| P09 | MCP notification authentication fails after fallback | Stop polling and disable authenticated work without deleting the credential |
| P10 | MCP notification result is invalid, credential-bearing, redirecting, or oversized | Stop the gateway without retrying the deterministic failure |
| W01 | Valid webhook wake | Send the fixed body, bearer token, valid HMAC V2 headers, and the same ID in both deduplication headers |
| W02 | Uncertain webhook outcome | Retry the same ID and body with a fresh timestamp and signature, never a new ID |
| A01 | Agent acknowledges through MCP | Forward with injected JWT and remove the buffered ID only after `{message_id,status:"acked"}` |
| A02 | Agent polls locally after a central poll consumed content | Return the in-memory full message without another central poll |
| A03 | Local agent call fails before `ack_message` while gateway remains running | Content remains locally retrievable and the gateway re-drives the same wake ID |
| A04 | Message has no ID | Return it once and do not call `ack_message` |
| A05 | Central becomes unavailable after a body is buffered | Return the buffered local poll result without another central request |
| A06 | `ack_message` fails, is uncertain, or returns a mismatched result | Keep the body locally retrievable and do not mark its wake terminal |
| S01 | Inspect files, SQLite, output, logs, diagnostics, and errors | Find no forbidden plaintext or MCP body data |
| S02 | Side-effecting upstream call times out | Do not retry automatically |
| S03 | Run without `--verbose=true` | Preserve the normal content-blind stdout and stderr boundary |
| S04 | Run with `--verbose=true` | Print non-credential bodies while redacting tokens, credential headers, and verification codes |
