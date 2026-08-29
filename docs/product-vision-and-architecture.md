# A2A gateway

Read this before working on the project.

## Status

Version `0.2.6` is the shipped compatibility implementation. ADRs 0023, 0025,
and 0026 define the accepted next contract as of 2026-08-29. The production
central service does not yet advertise that contract. Tests use the test-only
[version 2 fixture profile](v2-fixture-profile.md) for missing deployment
facts, but fixture URLs and policies are not production defaults.

## Product

The gateway is one foreground process between a local agent runtime and the
central A2A service. It runs an authenticated loopback MCP server, enrolls one
central identity, receives that identity's messages, and wakes one configured
webhook target.

The gateway does not discover OpenClaw, inspect agents, choose a runtime
adapter, manage bindings, or run a model. The user supplies a literal-loopback
webhook URL and an environment-variable reference for its bearer token:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The same bearer token authenticates calls from the local MCP client. The
gateway prints `http://127.0.0.1:8787/mcp` after it binds successfully. The
user configures that address in the local agent runtime.

## Rules

- One process owns one webhook target and one central identity.
- The foreground process accepts exactly the two required named startup
  options in `--name=value` form. ADR 0022 permits `--verbose=true` only as a
  temporary development diagnostic with paired development central endpoints.
- The MCP listener binds only to `127.0.0.1:8787`, validates `Host` and
  `Origin`, and authenticates every request with the webhook bearer token.
- Before enrollment, the local MCP catalog contains only `register_agent`,
  `verify_email`, and `resend_verification`.
- The accepted target sends those bootstrap operations through bounded central
  REST requests. Verification carries a DPoP issuance proof and returns a
  DPoP-bound token that the gateway intercepts before local result handling.
- Protected central REST and MCP HTTP requests use `Authorization: DPoP` and a
  fresh proof. Tokens never appear in local or upstream MCP tool arguments.
- Verification creates the first encrypted version 2 credential. Scheduled
  same-key reissue and explicit email-control recovery are the only credential
  replacement paths.
- Message bodies remain in bounded process memory. The notification journal
  contains opaque IDs and webhook relay state only.
- MCP arguments and results, task content, permission data, registration email,
  verification codes, tokens, private keys, proofs, and nonces never enter
  SQLite, configuration, normal logs, diagnostics, metrics, temporary files,
  crash artifacts, or support bundles. ADR 0022 temporarily permits a
  credential-redacted development transcript on stderr.
- The gateway does not hold model-provider credentials. Provider connectors do
  not receive the central credential or DPoP private key.
- No listener binds beyond loopback.

## Shipped `0.2.6` compatibility

The shipped release forwards bootstrap calls through central MCP. A successful
`verify_email` response is its only token source. It stores a JWT-only version
1 credential, uses bearer authentication for central REST polling, and injects
the token into protected central MCP tool arguments.

It calls `GET /api/poll_messages?timeout=30`. An explicit `404` switches that
process to the MCP `poll_messages` tool. Either operation consumes the returned
messages. The gateway keeps the bodies in memory and stores only present IDs
and relay state in SQLite. Because central cannot retrieve or redeliver a
consumed message, a gateway restart can lose an in-memory body. Startup deletes
the stale journal row instead of waking the webhook for unavailable content.

Those details remain accurate for `0.2.6`, but they are not the implementation
target. REST bootstrap, DPoP transport, version 2 credentials, token reissue,
email-control recovery, leased delivery, and the REST v2 message lifecycle
supersede them under ADRs 0023, 0025, and 0026.

## Accepted target flow

```text
Local agent runtime
  |  authenticated MCP using webhook token
  v
Gateway MCP server on 127.0.0.1:8787
  |  REST bootstrap before enrollment
  |  DPoP-authenticated REST and MCP after verification
  v
Central API and MCP service

Central REST v2 message API
  |  leased full-message receive after enrollment and activation
  v
Gateway in-memory inbox and ID-only journal
  |  bearer and HMAC webhook wake
  v
Configured local webhook
```

### Startup

1. Acquire the singleton lock before resolving tokens, opening credentials,
   binding MCP, receiving messages, or sending a webhook.
2. Resolve and validate the 48-character lowercase hexadecimal webhook token
   from the named environment variable.
3. Bind the authenticated MCP endpoint to `127.0.0.1:8787`.
4. Load an existing version 2 credential, if present, and require it to pass
   its token, key, endpoint, and storage checks. The future release is a fresh
   install and does not read or convert a version 1 credential.
5. Start version 2 receive only after a valid DPoP credential is available and
   central activation has completed.
6. Print the MCP endpoint and wait until interrupted.

### Enrollment and credential lifecycle

1. The local agent gathers username, optional display name, and email through
   normal conversation.
2. `register_agent` sends `POST /api/register` without a central access token.
3. `resend_verification` sends `POST /api/resend_verification` without a
   central access token.
4. For `verify_email`, the gateway creates a P-256 key and sends
   `POST /api/verify_email` with a DPoP issuance proof.
5. The gateway validates the response, token lifetime, subject, and public-key
   binding. It persists the token and private key as one encrypted version 2
   credential before enabling protected work or returning token-free success.
6. The gateway activates version 2 delivery through the fixed, idempotent REST
   activation operation. It does not infer, probe, or negotiate a version.

The token lasts 24 hours. Scheduled same-key reissue begins with 12 hours
remaining and atomically replaces only the same identity and key. Key loss,
expiry, revocation, and deliberate key rotation require a fresh email-control
verification. A `401`, invalid token, proof failure, key failure, or ordinary
tool failure never triggers renewal, registration, or credential replacement.

An unreadable credential cannot prove its identity. The gateway must not
overwrite it until the project approves an explicit local reset interface.

### Conversations and delivery

1. The gateway calls the fixed DPoP-authenticated
   `GET /api/v2/messages/receive?timeout=30&limit=100` route. It does not probe
   or fall back to a different REST route or central MCP.
2. Central returns the oldest bounded batch and leases each returned message
   for 60 seconds. An expired unacknowledged lease makes the same immutable
   message eligible again.
3. The gateway validates the batch, keeps bodies in bounded memory, and stores
   only message IDs and relay state in SQLite.
4. The webhook receives a fixed ID-only instruction with bearer and HMAC
   authentication and ID-based deduplication headers.
5. The local agent retrieves the in-memory message through local MCP. It records
   one idempotent reply or a terminal no-reply outcome, then acknowledges the
   message.
6. The gateway deletes the in-memory body and journal row only after central
   confirms `status: "acked"`.

A restart clears stale local wake rows. Lease expiry lets central redeliver the
full message. No crash-recovery path writes message or reply content to gateway
or connector durable state.

## Ownership

| Component | Responsibility |
| --- | --- |
| Central service | REST enrollment, DPoP-bound issuance and enforcement, authorization, leases, message content, conversations, replies, outcomes, and MCP tools |
| Gateway MCP path | Local bearer authentication, bootstrap tools, credential interception, token-free results, DPoP-authenticated central transport, limits, and cancellation |
| Gateway relay | Fixed REST v2 receive, bounded in-memory bodies, ID-only durable wake state, retries, terminal outcomes, and acknowledgement observation |
| Local runtime | User interaction, MCP tool use, model execution, and webhook handling |

## Deployment facts still needed

- Stable production issuer, API resource, API origin, MCP resource, and MCP
  endpoint values for package constants.
- Central implementation and staging evidence for REST bootstrap, DPoP
  enforcement, token lifecycle, lease redelivery, and version 2 messages.
- Native structured central MCP results before the temporary Python-literal
  compatibility parser can be removed.
- An approved local interface for intentional identity reset and an unreadable
  credential.

Tests may use the accepted test-only
[version 2 fixture profile](v2-fixture-profile.md) for these missing facts.
Production code must not copy its hostnames, signing keys, email behavior,
proxy trust, or capacity values into a release as if central had confirmed
them.
