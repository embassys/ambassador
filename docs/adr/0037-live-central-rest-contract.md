# 0037 Live central REST contract

Status: accepted

Date: 2026-09-01

## Problem

The gateway documentation treated a proposed versioned API as a fixed future
contract. It required `/api/v2` routes, central MCP transport, token reissue,
delivery activation, leases, conversations, replies, outcomes, and migration
behavior that the central service does not implement.

The product is still in development. Maintaining two client generations or
forcing the server to implement a speculative design would delay a working
integration without serving an installed compatibility requirement.

## Evidence

The current source baseline is
[`embassys/agent2agent@b769896`](https://github.com/embassys/agent2agent/tree/b769896b7cfb1ee3540195be9e7a61cf777b9388).
The hosted service is `https://mcp.embassys.ai`.

On 2026-09-01, live checks established that:

- email-only registration and verification work through the REST API;
- verification accepts a P-256 public JWK in its JSON body and returns a
  DPoP-bound token;
- the response JWK thumbprint and the token's `cnf.jkt` match the submitted
  key;
- a protected request succeeds with `Authorization: Bearer <token>` and a
  separate `DPoP` proof header;
- the same bound token without a proof is rejected;
- a proof signed by a different key is rejected;
- reusing a proof is rejected; and
- `Authorization: DPoP <token>` is rejected.

The deployment does not expose a build identifier. Its observed DPoP behavior
matches the pinned source. That is sufficient for the current development
cutover. A release claim should still record a deploy revision when the server
provides one.

The first hosted `/openapi.json` and `/api/list_action_types` checks returned
server errors. Commit `b769896` added database JSON codecs and repaired the
catalog. After deployment, generated OpenAPI returned `200` and an
authenticated catalog returned six actions, including `get_email` and
`get_phone_number` with required string `reason`.

## Decision

### One current client

The gateway implements one central client for the current server. It does not
retain or migrate the published bearer-only behavior and does not retain the
speculative versioned client.

Delete these paths when the current integration is implemented:

- central MCP discovery and tool calls;
- token arguments in upstream MCP calls;
- the REST-to-MCP polling fallback;
- `/api/v2` activation, conversation, receive, reply, completion, outcome,
  reissue, and revocation clients;
- bearer-only credential support;
- old credential readers and migration branches; and
- the development verbose transcript added for the old MCP integration.

Internal storage may use a format marker. That marker is not an API version
and does not create a migration requirement.

### Central REST surface used by the gateway

Bootstrap calls use no central access token:

| Operation | Request |
| --- | --- |
| Register | `POST /api/register_agent` with `email` and optional `display_name` |
| Verify | `POST /api/verify_email` with `email`, six-character `code`, and the gateway's public `jwk` |
| Resend | `POST /api/resend_verification` with `email` |

Protected work uses these REST routes:

| Operation | Request |
| --- | --- |
| List action types | `GET /api/list_action_types` |
| Request permission | `POST /api/request_permission` |
| Grant or deny | `POST /api/respond_to_permission` |
| Deliver an action call | `POST /api/call_action` |
| Poll messages | `GET /api/poll_messages?timeout=<seconds>` |
| List permissions | `GET /api/get_my_permissions` |
| Acknowledge a message | `POST /api/ack_message` |

The gateway does not use central MCP or OAuth. It also does not expose the
duplicate `/api/grant_permission` and `/api/deny_permission` routes. Public
invitation and health routes are server or human surfaces, not gateway MCP
tools.

The API stays unversioned while the product is in development. A future
breaking change updates the source pin, fixtures, tests, client, and docs in
one reviewed change. The gateway does not probe, negotiate, or fall back at
runtime.

### DPoP issuance and requests

The gateway creates one ES256 P-256 key pair immediately before verification.
It sends only the public `kty`, `crv`, `x`, and `y` members in the verification
body. Verification does not carry a DPoP proof.

The successful response contains `agent_id`, `email`, `token`, optional `jkt`,
and `message`. The gateway intercepts the token, confirms the returned and JWT
thumbprints match its public key, and atomically persists the token and private
key in the encrypted credential store before it reports token-free success.

The current access token is an HS256 JWT with `sub`, `email`, `iat`, `exp`, and
`cnf.jkt`. The configured lifetime is 30 days. The client cannot verify the
server's symmetric signature. It validates the compact shape, timestamps,
identity fields, and key binding, then treats the serialized token as opaque.

Each protected REST request sends:

```http
Authorization: Bearer <DPoP-bound-token>
DPoP: <ES256-proof-JWT>
```

The proof header contains `typ: dpop+jwt`, `alg: ES256`, and the public JWK.
The payload contains a unique `jti`, exact uppercase `htm`, exact full request
URL in `htu`, current Unix `iat`, and base64url SHA-256 token hash in `ath`.
The full URL includes the query string. The server accepts proofs no more than
60 seconds old and allows five seconds of future clock skew.

A nonce is not required on the first request. If a `401` response supplies a
`DPoP-Nonce` header, the client may repeat that request once with the nonce and
a new proof. It does not retry other authentication failures or replace the
credential after a `401`.

### Permissions, actions, and messages

The server models agent interaction as permissions and action calls. It does
not provide the proposed free-text conversation, reply, completion, outcome,
activation, or lease routes.

`list_action_types` is the authority for deployed action names and input
schemas. The pinned live catalog includes `get_email` and `get_phone_number`;
both accept an object with required string `reason`.

`poll_messages` atomically changes queued rows to `delivered` before returning
their bodies. `ack_message` changes one delivered row to `acked`; a repeat
returns `404`. There is no lease or delivered-message retrieval. A crash after
receive and before acknowledgement can lose the in-memory body. That is an
accepted development limitation and must remain visible in status and release
documentation.

The gateway keeps returned bodies in bounded memory. SQLite contains message
IDs and webhook relay state only. It clears stale wake rows after a restart
because their bodies cannot be recovered.

### Errors and retries

The server returns FastAPI-style JSON errors with a `detail` member. The
gateway maps them to bounded safe local errors and does not require a proposed
error-code envelope.

The client rejects redirects. It may retry a poll after a transport failure
because a lost poll response can already have consumed messages; that risk is
part of the current development limitation. It does not automatically retry a
side-effecting registration, verification, permission, action, response, or
acknowledgement request after an uncertain outcome.

### Data boundary

Tokens, private keys, proofs, verification codes, email addresses, action
payloads, permission details, messages, MCP bodies, and remote response bodies
must not enter SQLite, normal logs, diagnostics, metrics, temporary files,
crash artifacts, or support bundles. The encrypted credential is the only
approved durable location for the token and private key.

## Supersession

This record:

- amends ADR 0017's central transport and message sections;
- amends ADR 0019 to one current encrypted DPoP credential with no replacement
  or migration path;
- amends ADR 0020's fixture target;
- supersedes ADRs 0021, 0022, 0023, 0025, 0026, 0027, and 0032; and
- supersedes the central conversation, reply, completion, and acknowledgement
  assumptions in ADRs 0024 and 0030.

Provider process isolation, local authentication, content-free persistence,
and provider-specific safety decisions remain in force where they do not
depend on the removed central lifecycle.

## Consequences

The gateway can be made useful against the deployed server without waiting
for a second API generation. The implementation becomes smaller and removes
multiple unshipped compatibility branches.

The current server has weaker crash recovery and token lifecycle behavior than
the proposed design. Those are follow-up improvements, not hidden client
requirements. If the server later adds them, source, live behavior, tests, and
the client move together under a new decision.
