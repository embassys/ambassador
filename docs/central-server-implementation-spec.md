# Central server implementation specification

Status: implementation-ready handoff for external S01 through S07; live
revision alignment pending

Date: 2026-08-30

## Authority and scope

This document translates accepted ADRs 0023, 0025, 0026, and 0027 into work
for the central service repository. Those ADRs remain normative. A conflict
returns this specification for correction rather than changing the accepted
client contract in server code.

The central repository is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). The project
owner reports that DPoP is implemented, but the exact DPoP commit and deployed
revision have not been pinned. The owner also reports new templates for asking
a user for an email address or phone number. I01 in the gateway implementation
plan inventories the complete current REST, MCP, template, and event surface,
traces flow impacts, compares that exact revision with this specification, and
returns any material client-visible difference for ADR review. I02 then runs
the first full DPoP development E2E using an approved low-impact contact
template and synthetic or disposable data. Neither task weakens S01 through
S07.

The target is a fresh version 2 identity. Do not migrate a version 1
credential, identity, mailbox row, or delivery state. Do not add protocol
discovery, a version option, route probing, or fallback. Keep the current
version 1 API consumed by gateway `0.2.6` as a separate regression contract
for its existing identities. A future gateway selects its version at build and
review time. This document assigns no release number to the external central
service.

This specification fixes externally observable behavior. It does not choose a
server framework, programming language, database product, queue, proxy, email
provider, or deployment system. Central owners choose those implementation
details, provided that the transaction, shared-state, limit, and black-box
requirements below hold across every replica.

Branding, provider connectors, hosted-agent integration, ACP, GUI work, and a
local gateway reset interface are outside this handoff.

## Contract precedence

Apply these sources in order:

1. ADR 0027 for the fresh-install boundary.
2. ADR 0026 for DPoP issuance, transport authentication, nonce, replay,
   reissue, recovery, and revocation.
3. ADR 0025 for version 2 conversations, delivery, outcomes, and
   acknowledgement.
4. ADR 0023 for REST enrollment.
5. This implementation specification.
6. `central-interface-change-requests.md` for current-versus-target context.
7. `v2-fixture-profile.md` for tests only.

Fixture identifiers, keys, hosts, accounts, codes, clocks, secrets, proxy
peers, and control routes are not production defaults. A material difference
between the intended production interface and items 1 through 4 requires ADR
review before implementation.

## Current and target contracts

Central must run two distinct contracts during the compatibility period.

| Contract | Identity class | Authentication | Delivery | Required handling |
| --- | --- | --- | --- | --- |
| Current API consumed by gateway `0.2.6` | Existing version 1 identity | Existing bearer JWT and existing MCP token argument | Consuming `GET /api/poll_messages`, with the existing MCP consuming poll and acknowledgement behavior | Preserve as a regression baseline. Do not silently give it version 2 lease semantics. |
| Accepted target | New version 2 identity | DPoP-bound JWT and transport DPoP | Fixed REST version 2 lifecycle | Implement this specification. Never accept its token through bearer authentication or an MCP tool argument. |

The unversioned target bootstrap routes do not alter the existing version 1
MCP bootstrap contract. A new version 2 gateway uses only `POST /api/register`,
`POST /api/verify_email`, and `POST /api/resend_verification` for bootstrap.
It never calls `/api/register_agent` or central MCP bootstrap. Existing
version 1 clients may continue using their existing MCP contract.

Version 1 and version 2 identities do not share a delivery queue or change
delivery version. The version 2 activation transaction applies only to a fresh
identity created for this contract. `migration_incomplete` is not a required
fresh-install path or acceptance case. Do not implement mailbox conversion as
part of S01 through S07.

## Production facts central must publish

Central owners must fill a deployment record before S07. Do not use fixture
values for any blank item.

| Fact | Requirement |
| --- | --- |
| Canonical issuer | One exact HTTPS issuer identifier used in `iss` validation |
| Canonical API origin | One exact external HTTPS origin for bootstrap and `/api/v2` |
| API resource | One exact audience string, first in the JWT `aud` array |
| Canonical MCP endpoint | One exact external HTTPS URL ending at the stable `/mcp` path |
| MCP resource | One exact audience string, second in the JWT `aud` array |
| JWT signing policy | Signing algorithm, key source, rotation, overlap, verification, emergency revocation, and maximum encoded token size |
| Username comparison | The exact case and Unicode comparison used for registration uniqueness and recipient lookup |
| Trusted proxy peers | Exact peer identities or network ranges allowed to supply external scheme, host, and port |
| Security domains | Stable identifiers for issuance, API, and MCP nonce and replay isolation |
| Shared state | Mechanisms and measured capacity for replay, revocation, rate limits, leases, idempotency, and transactions across replicas |
| Email comparison | Publication of the exact `email-comparison-v1` byte rule in this specification |
| Email controls | Code alphabet, delivery provider, abuse controls, suppression behavior, and security-notice delivery |
| Capacity | Evidence that the accepted mailbox, request, replay, token, and recovery limits fit production |
| Rollout | Development enablement, staging, production enablement, and version 1 retirement dates |

S07 does not pass while any value is represented by a fixture URN, `.invalid`
name, fixture key, fixed fixture secret, loopback origin, or test-control
header.

## Common HTTP rules

All target endpoints use the canonical API origin. `/mcp` uses the canonical
MCP endpoint. Production accepts HTTPS only. No target endpoint redirects,
aliases a path, or falls back to a version 1 handler. An unsupported method or
path changes no state.

Every JSON request uses `Content-Type: application/json; charset=utf-8` and
every JSON response uses `Content-Type: application/json`, optionally with a
UTF-8 charset. The service rejects compressed target requests. Every target
REST JSON response, including success, application error, and DPoP issuance
error, has no `Content-Encoding`. It rejects duplicate JSON keys, invalid
UTF-8, trailing data, lone UTF-16 surrogates, non-finite numbers, unknown
fields in strict request objects, and values outside the route's bounds before
state change.

Target responses do not expose remote stack text. Every verification, reissue,
protected version 2 success, nonce challenge, and DPoP authentication error
includes `Cache-Control: no-store`. Successful verification and reissue should
also include `Pragma: no-cache`. Proxies and shared caches must not store those
responses.

The service accepts at most 16 KiB of request headers. It rejects an
over-limit field before decoding a JWT or proof. The access token and DPoP
proof each contain at most 4,096 ASCII bytes. The complete authorization value
contains at most 4,101 ASCII bytes. Both credential field values together
contain at most 8,197 bytes.

Bootstrap request bodies contain at most 2 KiB. Bootstrap responses contain
at most 16 KiB of headers and 64 KiB of body, with at most 16 JSON container
levels, 1,024 structural tokens, 128 object members, and 128 array elements.
Version 2 REST request bodies contain at most 524,288 UTF-8 bytes. A version 2
HTTP response contains at most 4 MiB and at most 100 JSON container levels.
The receive result has the smaller exact 524,288-byte limit specified below.

The gateway has a 30-second deadline for bootstrap and non-receive operations.
Receive may hold for at most the requested 30 seconds so that the gateway's
40-second total deadline remains sufficient. Server cancellation must release
an active receive slot without leasing rows that were not committed.

## Identifier and text rules

Message, conversation, and agent IDs contain 1 through 128 URI-unreserved
ASCII characters matching `[A-Za-z0-9._~-]+`. Central generates message and
conversation IDs. Message IDs are globally unique and never reused.

Client request and proof IDs are lowercase canonical UUID v4 strings matching
`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
An idempotency key is opaque and must not contain an email, username, message,
timestamp, or credential.

A conversation payload has exactly `{"text":"..."}`. Decoded text contains
1 through 262,144 UTF-8 bytes. Central preserves the exact decoded Unicode
string and does not normalize it for idempotency comparison.

An inbound `created_at` value is RFC 3339 UTC with exactly three fractional
second digits and a trailing `Z`.

## REST route catalog

### Bootstrap routes

Each bootstrap request sends `Accept: application/json`,
`Content-Type: application/json; charset=utf-8`, and
`Cache-Control: no-store`. These routes carry no cookies or central access
token. Registration and resend carry no `DPoP` header. Verification carries
one `DPoP` issuance proof and no `Authorization` header. Central sets no
cookie in a bootstrap response.

| Operation | Request | Success |
| --- | --- | --- |
| `POST /api/register` | `{"email":"test@example.com","username":"test_agent"}` with optional `display_name` | HTTP `200`, `{"agent_id":"agent_123","username":"test_agent","email":"test@example.com","message":"Verification code sent."}`. `message` is optional. |
| `POST /api/verify_email` | `{"email":"test@example.com","code":"123456"}` and one issuance `DPoP` proof, no `Authorization` | HTTP `200`, `{"agent_id":"agent_123","username":"test_agent","token":"<jwt>","token_type":"DPoP","expires_in":86400,"message":"Email verified successfully."}`. `message` is optional. |
| `POST /api/resend_verification` | `{"email":"test@example.com"}` | HTTP `200`, `{"message":"Verification code resent."}`. `message` is optional. The observable result is identical for a pending identity, verified identity, and unknown valid email. |

Registration fields use these bounds:

| Field | Rule |
| --- | --- |
| `email` | 3 through 254 characters, at most 254 UTF-8 bytes, matches `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `username` | 3 through 50 characters and at most 200 UTF-8 bytes |
| `display_name` | If present, 1 through 128 characters and at most 512 UTF-8 bytes |
| `code` | Exactly six ASCII alphanumeric characters, case preserved |

All fields reject null, empty values, leading or trailing whitespace, and
ASCII control characters. The server applies the published username
comparison for uniqueness and recipient lookup. It must not require a client
to trim, lowercase, or otherwise rewrite a submitted value.

Use one published `email-comparison-v1` key for registration uniqueness,
resend, verification, recovery, and every email-scoped rate limit. After the
request passes the exact field validation above, encode it as UTF-8 and map
each ASCII byte `A` through `Z` to `a` through `z`. Preserve every other byte.
Do not trim, apply Unicode normalization or case folding, convert IDNs, remove
dots or plus tags, or use provider-specific aliases. Preserve the originally
registered email separately for delivery and the registration response. This
comparison algorithm is deliberately small and version-independent. Central
must publish its name and byte rule with the deployed schema.

Pending enrollment and recovery codes live for exactly ten minutes. One
pending enrollment code allows at most ten failed verification attempts. The
tenth failure atomically invalidates it. Recovery also remains subject to
S06's ten-attempt rolling-hour limit. A resend atomically replaces the old
purpose-specific code and its per-code attempt count.

Store no plaintext or plain digest of a code. Use a 32-byte managed HMAC key
and store its key ID plus this verifier:

```text
HMAC-SHA-256(
  code-key,
  ASCII "a2a-email-code-v1" ||
  scope-byte ||
  uint16be(email-comparison-key byte length) ||
  email-comparison-key ||
  0x06 ||
  six ASCII code bytes
)
```

The scope byte is `0x01` for pending enrollment and `0x02` for recovery. Use
the exact email comparison bytes above. Reject another length, encoding,
scope, or trailing byte. Compare the 32-byte verifier in constant time. For an
unknown email or missing active code, compute and compare a dummy verifier
through the same path before returning the generic result.

The code-key ring contains at most a current and previous key. Rotate no more
often than once per 24 hours and retain the previous key until every code that
names it has expired, for at least ten minutes after rotation. Never silently
try an unrecorded key ID. Code expiry, attempt claim, verifier comparison,
success consumption, and identity transition use database time and one
transaction across replicas.

Registration reserves an email and username and creates one pending identity.
Any existing pending or verified email, existing username, or exact repeat
returns the same generic conflict. It reveals neither the matching field nor
an agent ID.

Resend atomically supersedes the older code for the same purpose. A pending
identity receives an enrollment code. An existing verified version 2 identity
receives a recovery code. An unknown valid email receives no email. The HTTP
result is identical in all three cases. Codes are purpose-bound, single-use,
stored as a verifier rather than plaintext, and only the newest code for one
purpose remains valid.

The fixed recovery limits appear under S06. Production registration and
pending-enrollment resend rate limits remain a central fact that the owner must
publish. A production rate choice must preserve the error and non-enumeration
contract here.

Verification validates the issuance proof before reading or consuming the
code. A valid pending-registration code verifies the identity and creates its
first DPoP token. A valid recovery code performs the atomic recovery transaction
under S06. Any unknown, invalid, expired, consumed, or superseded code returns
the same failure. A successful code is consumed and can never return the same
token again. A lost success is recovered with a new recovery code and new key,
not by repeating the consumed code.

### Protected version 2 routes

Every route in this table requires a valid `Authorization: DPoP <jwt>` header,
a valid fresh `DPoP: <proof>` header, and the identity state required by the
operation. DPoP authentication finishes before request-body parsing or
application state change.

| Operation | Request | Success |
| --- | --- | --- |
| `POST /api/v2/delivery/activate` | Empty body and `Content-Length: 0` | HTTP `200`, `{"delivery_version":"v2","status":"active"}` |
| `POST /api/v2/conversations` | UUID v4 `Idempotency-Key`; `{"recipient_username":"target-agent","payload":{"text":"Please review the change."}}` | HTTP `201` on first acceptance and `200` on an identical repeat; `{"message_id":"msg_123","conversation_id":"conv_456","status":"accepted"}` |
| `GET /api/v2/conversation-starts/{request_id}` | No body | HTTP `200`, the accepted or not-found object specified below |
| `GET /api/v2/messages/receive?timeout=30&limit=100` | No body; `timeout` integer 0 through 30 and `limit` integer 1 through 100, each exactly once | HTTP `200`, `{"messages":[...]}` |
| `POST /api/v2/messages/{message_id}/reply` | Exact derived `Idempotency-Key`; `{"payload":{"text":"The change is ready."}}` | HTTP `200`, `{"message_id":"msg_reply_345","conversation_id":"conv_456","status":"accepted"}` |
| `POST /api/v2/messages/{message_id}/complete` | `{"outcome":"unsupported","reason_code":"unsupported_message_type"}` | HTTP `200`, `{"message_id":"msg_123","outcome":"unsupported","status":"recorded"}` |
| `GET /api/v2/messages/{message_id}/outcome` | No body | HTTP `200`, exact open or terminal object |
| `POST /api/v2/messages/{message_id}/ack` | Empty body and `Content-Length: 0` | HTTP `200`, `{"message_id":"msg_123","status":"acked"}` |
| `POST /api/v2/token/reissue` | UUID v4 `Idempotency-Key`; exact body `{}` | HTTP `200`, `{"token":"<new-jwt>","token_type":"DPoP","expires_in":86400}` |
| `POST /api/v2/token/revoke` | `{"scope":"identity"}` | HTTP `204` with no body |

A successful start lookup has this exact body:

```json
{
  "request_id": "54d67b8a-b298-4e3b-923c-6f9f8ced71a5",
  "status": "accepted",
  "message_id": "msg_123",
  "conversation_id": "conv_456"
}
```

An unrecorded ID has this exact body:

```json
{
  "request_id": "54d67b8a-b298-4e3b-923c-6f9f8ced71a5",
  "status": "not_found",
  "message_id": null,
  "conversation_id": null
}
```

An open outcome has this exact shape:

```json
{
  "message_id": "msg_123",
  "conversation_id": "conv_456",
  "status": "open",
  "outcome": null,
  "reply_message_id": null
}
```

A replied outcome has this exact shape:

```json
{
  "message_id": "msg_123",
  "conversation_id": "conv_456",
  "status": "terminal",
  "outcome": "replied",
  "reply_message_id": "msg_reply_345"
}
```

For another terminal outcome, `status` is `terminal`, `outcome` is that exact
outcome, and `reply_message_id` is null.

### Version 2 message schema

Each receive item has exactly this shape:

```json
{
  "id": "msg_123",
  "conversation_id": "conv_456",
  "sender_agent_id": "agent_789",
  "message_type": "conversation_turn",
  "in_reply_to_message_id": null,
  "payload": {
    "text": "Please review the change."
  },
  "created_at": "2026-08-29T12:00:00.000Z"
}
```

The first turn has a null reply link. Every later turn names the immediately
preceding message in the same conversation. A predecessor has at most one
reply. The message's logical JSON value is immutable. A repeated message ID
always returns the same logical value.

### Completion values

`complete` accepts only these pairs:

| Outcome | Allowed reason code |
| --- | --- |
| `completed_without_reply` | `no_reply_required` |
| `unsupported` | `unsupported_message_type`, `unsupported_payload` |
| `failed` | `provider_start_failed`, `provider_execution_failed`, `provider_result_invalid` |
| `cancelled` | `cancelled_before_execution`, `cancelled_during_safe_wait` |
| `uncertain` | `provider_outcome_unknown` |

Waiting for provider approval is not terminal. The client records no
completion and no acknowledgement while it waits.

## MCP contract

Keep Streamable HTTP at the canonical `/mcp` endpoint. Every HTTP request in a
version 2 MCP session uses its actual method and carries fresh DPoP transport
authentication. Initialization, tool listing, tool calls, notifications,
reconnect GET requests, and session termination all require it. An MCP session
ID does not authenticate another HTTP request.

Apply the header limit before decoding the transport credential. Apply the
remaining fixed transport and execution limits after header authentication:

| MCP resource | Limit |
| --- | --- |
| Request headers | 16 KiB, including the DPoP fields |
| One Streamable HTTP request body | 1 MiB of received bytes |
| One Streamable HTTP response body | 4 MiB of sent bytes |
| JSON nesting | 100 container levels |
| JSON structural tokens | 16,384 |
| Serialized native tool result before an optional text mirror | 512 KiB |
| Active MCP sessions per authenticated identity | 32 across all replicas |
| Concurrent `tools/call` operations per authenticated identity | 8 across all sessions and replicas |

Authenticate DPoP before reading a protected request body. Then enforce the
body limit incrementally and stop reading when the next byte would exceed it.
Reject a JSON-RPC batch array before dispatching any member. A rejected batch,
malformed request, duplicate key, over-limit value, unknown method, or invalid
parameters performs no tool or business operation. A ninth concurrent tool
call or a thirty-third session fails with `temporarily_unavailable` and
allocates no extra execution slot or session. `receive_messages` also remains
subject to the stricter one-active-receive rule.

DPoP errors remain HTTP authentication challenges. After authentication, MCP
returns HTTP `200` with this exact JSON-RPC error for an application failure:

```json
{
  "jsonrpc": "2.0",
  "id": "<request-id-or-null>",
  "error": {
    "code": -32002,
    "message": "operation failed",
    "data": {
      "code": "message_not_found",
      "retry_after_ms": null
    }
  }
}
```

Use the request ID only when the server parsed one valid scalar ID from a
single request. Otherwise use null. Every application error uses numeric code
`-32002` and fixed message `operation failed`. Its `data` is exactly the inner
REST application error object. `rate_limited` alone carries its positive
`retry_after_ms`; the HTTP response also carries the matching `Retry-After`.
Transport-limit, batch, JSON, method, and parameter failures use application
code `invalid_request` with null retry delay. A response still carries
`Cache-Control: no-store` and no content encoding. Do not return a stack,
request excerpt, credential, proof field, or remote exception message.

Version 2 tool input schemas contain no `token`, credential, sender, target,
conversation, provider-session, or idempotency selector unless the REST
contract expressly includes that business field. The required message tools
are:

| Tool | Exact business input |
| --- | --- |
| `start_conversation` | `recipient_username`, `payload`, `request_id` |
| `get_conversation_start` | `request_id` |
| `receive_messages` | `timeout_seconds`, `limit` |
| `reply_message` | `message_id`, `payload` |
| `complete_message` | `message_id`, `outcome`, `reason_code` |
| `get_message_outcome` | `message_id` |
| `ack_message` | `message_id` |

The MCP service derives the same operation and idempotency identities as REST.
It uses the same database state, authorization, limits, transactions, and
errors. Every tool returns native JSON in `structuredContent` that matches its
advertised output schema. Do not wrap a Python representation or JSON string
inside `structuredContent.result`. A text mirror, if the MCP protocol requires
one, must be generated from the same bounded native value. Enforce the 512 KiB
native-result limit before building that mirror and the 4 MiB limit while
sending the complete response.

Current version 1 MCP tools and token arguments remain a separate regression
contract for version 1 credentials. A token with `cnf.jkt` never enters that
path. Version 2 tools never accept a tool-argument token.

## DPoP proof and token profile

### Proof structure

The protected JOSE header contains exactly `typ`, `alg`, and `jwk`:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "<unpadded-base64url-32-bytes>",
    "y": "<unpadded-base64url-32-bytes>"
  }
}
```

Reject any unknown or duplicate header member, unprotected header, private
`d`, symmetric key, `kid`, certificate reference, or remote key URL. Verify an
ES256 signature using the included public P-256 key. Compute its RFC 7638
thumbprint over canonical `crv`, `kty`, `x`, and `y` members.

An issuance payload has exactly `jti`, `htm`, `htu`, `iat`, and, when answering
a challenge, `nonce`. It omits `ath`. A protected-resource payload adds
`ath`. Reject unknown or duplicate claims. `jti` uses the UUID rule above.
`iat` is an integer NumericDate no more than 60 seconds old and no more than 5
seconds in the future.

`htm` exactly matches the case-sensitive HTTP method. `htu` is the normalized
external absolute URI without query or fragment. Normalize it by:

- lowercasing scheme and host;
- removing the scheme's default port;
- uppercasing percent-encoding hex digits and decoding percent-encoded
  unreserved characters;
- removing dot segments;
- representing an empty path as `/`; and
- preserving path case, reserved characters, consecutive slashes, and a
  trailing slash.

For a protected request, `ath` is the unpadded base64url SHA-256 digest of the
ASCII access-token bytes. The proof JWK thumbprint must equal the signed access
token's `cnf.jkt`.

### Access token

A successful verification issues a signed JWT with this required payload:

```text
{
  "iss": "<canonical-production-issuer>",
  "aud": ["<canonical-api-resource>", "<canonical-mcp-resource>"],
  "sub": "agent_123",
  "iat": <integer-issued-at-numeric-date>,
  "exp": <integer-issued-at-plus-86400>,
  "jti": "<lowercase-uuid-v4>",
  "cnf": {
    "jkt": "<rfc7638-thumbprint>"
  }
}
```

`sub` equals the returned `agent_id`. The ordered audience array has exactly
the API resource followed by the MCP resource. `exp - iat` is exactly 86,400
seconds. The JWT has one new token `jti`. It may contain bounded authorization
claims fixed by central policy, but never an email, verification code, private
key, proof, or nonce. Its encoded form remains within 4,096 ASCII bytes.

Every protected request validates the signature, fixed issuer, appropriate
resource audience, subject, token ID, time, revocation state, authorization
claims, `cnf.jkt`, authorization scheme, and proof before application parsing
or dispatch. A DPoP-bound token never enters bearer validation.

Use this authentication order for both issuance and resources:

1. Enforce header and encoded-value limits and reject repeated fields.
2. Strictly parse the compact proof and token, where a resource token exists.
3. Validate all proof header, signature, method, URI, time, key, token,
   audience, and `ath` rules that do not depend on the nonce.
4. Validate the nonce. If that is the only missing or stale requirement,
   return a fresh bound challenge and perform no application work.
5. Atomically claim the replay digest after every other authentication check.
6. Only then parse or dispatch the application request.

An invalid signature, token, proof key, method, URI, or token hash does not
receive a nonce challenge that could hide that error. It allocates no replay
state.

### Nonce

Require a nonce for every issuance and protected-resource proof. A request
without one may proceed only far enough to receive a challenge. It performs no
application work.

An issuance challenge is HTTP `400` with exactly one `DPoP-Nonce` header, the
flat body `{"error":"use_dpop_nonce"}`, JSON content type, and `no-store`.
A resource challenge is HTTP `401` with exactly one `DPoP-Nonce` header,
`WWW-Authenticate: DPoP error="use_dpop_nonce"`, and `no-store`.

The nonce decodes to exactly 57 bytes:

| Field | Encoding |
| --- | --- |
| Version | One byte, value `1` |
| Issued time | Eight-byte unsigned big-endian Unix time |
| Random | 16 operating-system random bytes |
| Tag | 32-byte HMAC-SHA-256 |

Return its exact 76-character unpadded base64url encoding. Use a 32-byte MAC
key and this exact MAC input, with no terminator or padding bytes:

```text
17 bytes  ASCII "a2a-dpop-nonce-v1"
1 byte    scope, 0x01 for issuance or 0x02 for a resource
2 bytes   unsigned big-endian byte length of the security-domain identifier
N bytes   UTF-8 security-domain identifier, 1 through 255 bytes
1 byte    binding count, exactly 1 for issuance or 2 for a resource
for each binding in the order below:
  2 bytes unsigned big-endian byte length
  N bytes ASCII binding, 1 through 128 bytes
25 bytes  nonce prefix: version, issued time, and random bytes
```

The sole issuance binding is the 43-character unpadded base64url proof-key
thumbprint. Resource bindings are the URI-unreserved token subject followed by
that thumbprint. The tag is `HMAC-SHA-256(mac-key, exact-input)` and is appended
to the 25-byte prefix. Reject another scope byte, binding count, encoding,
length, field order, or trailing byte. Compare the supplied and computed tags
in constant time before interpreting the bound values as authenticated.

These fixed vectors test the byte grammar only. Their key, domains, subject,
time, random bytes, and thumbprint are not production values. Both use MAC key
hex
`000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`,
issued time `1700000000`, random hex
`101112131415161718191a1b1c1d1e1f`, and thumbprint
`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`.

Issuance vector, scope `0x01` and security domain
`issuance.prod.example`:

```text
MAC input hex:
6132612d64706f702d6e6f6e63652d763101001569737375616e63652e70726f642e6578616d706c6501002b4141414141414141414141414141414141414141414141414141414141414141414141414141414141414101000000006553f100101112131415161718191a1b1c1d1e1f
tag hex:
e42f225e156f187d9a46dd4d03eb2a72afe00d8378c24a99833ff1e0610a226f
nonce base64url:
AQAAAABlU_EAEBESExQVFhcYGRobHB0eH-QvIl4Vbxh9mkbdTQPrKnKv4A2DeMJKmYM_8eBhCiJv
```

Resource vector, scope `0x02`, security domain `api.prod.example`, and subject
`agent_123`:

```text
MAC input hex:
6132612d64706f702d6e6f6e63652d76310200106170692e70726f642e6578616d706c650200096167656e745f313233002b4141414141414141414141414141414141414141414141414141414141414141414141414141414141414101000000006553f100101112131415161718191a1b1c1d1e1f
tag hex:
af3774c4f333f4ad7697831f7ad70f1ad11aace8b49e967d8d8f6426ee169175
nonce base64url:
AQAAAABlU_EAEBESExQVFhcYGRobHB0eH683dMTzM_StdpeDH3rXDxrRGqzotJ6WfY2PZCbuFpF1
```

Use a shared managed MAC key ring with at most a current and previous key.
Rotate no more often than every 24 hours. Retain the previous key for five
minutes and five seconds. Accept a nonce for five minutes after issue and up
to five seconds of future clock skew. A nonce is stateless and creates no
database row. Send a replacement after successful authentication when the
presented nonce is at least four minutes old.

### Replay

After every other authentication check passes, atomically claim:

```text
SHA-256(security-domain || 0x00 || jkt || 0x00 || htm || 0x00 || normalized-htu || 0x00 || jti)
```

Keep the 32-byte digest for 65 seconds after first acceptance. Reject a
duplicate across any replica before application work. Admit at most 256 live
digests per proof-key thumbprint and security domain and 1,000,000 live
digests per security domain. Never evict an unexpired digest to admit another.
The 257th per-key proof returns `dpop_rate_limited`. Full domain capacity
returns `temporarily_unavailable`.

Invalid signatures, claims, keys, tokens, and nonces allocate no replay or
nonce state.

### Authentication errors

Authentication failures do not use the version 2 nested application envelope.

| Context | HTTP result |
| --- | --- |
| Issuance needs nonce | `400`, exact flat `{"error":"use_dpop_nonce"}`, one valid nonce header |
| Issuance proof invalid | `400`, exact flat `{"error":"invalid_dpop_proof"}` |
| Resource needs nonce | `401`, DPoP challenge with `error="use_dpop_nonce"`, one valid nonce header |
| Resource proof invalid | `401`, DPoP challenge with `error="invalid_dpop_proof"` |
| Token invalid, expired, or revoked | `401`, DPoP challenge with `error="invalid_token"` |
| Per-key replay capacity reached | `429`, integer delta-seconds `Retry-After`, flat `{"error":"dpop_rate_limited"}` |
| Shared authentication state unavailable or full | `503`, flat `{"error":"temporarily_unavailable"}` |

Each failure happens before application parsing, lease acquisition,
idempotency reservation, code consumption, MCP dispatch, or another business
side effect.

## Authenticated request-rate admission

Use one shared rolling 60-second admission record per authenticated identity
for REST and MCP together. Database time defines the window. Atomically record
every DPoP-authenticated non-receive application attempt, including malformed
input, a reviewed application error, an idempotent repeat, and an attempt that
is already over the limit. The attempt remains charged for the full rolling
window. Permit at most 120 such attempts in any window across all replicas.

The rule covers activation, start and start lookup, reply, completion, outcome
lookup, acknowledgement, reissue, revocation, and their MCP tool equivalents.
For MCP, every authenticated `tools/call` counts unless it is the exact
`receive_messages` operation. An unknown tool or invalid tool call counts.
MCP initialization, tool listing, notifications, reconnect, and session close
do not count. REST receive and MCP `receive_messages` do not count because the
one-active-receive rule controls them. DPoP challenges and authentication
failures do not count because no application identity has been admitted.

For a non-start route or parsed MCP tool call, choose the admission result
before body-schema, parameter, idempotency, or business results. An idempotent
repeat can therefore receive `rate_limited`; it is not a free request. An
over-limit malformed call returns `rate_limited`, while the same call within
the limit returns `invalid_request`. Authentication errors still take
precedence because they happen before this counter.

A start has one deliberate response-order exception. Charge its authenticated
sender in the shared counter, validate its strict input, then evaluate
recipient existence, opt-in, and grant before exposing any rate result. A
denied start always returns `recipient_unavailable`, even when the sender is
over the shared limit. It creates no recipient-pair rate row, start-specific
rate row, idempotency row, or mailbox observation. For an authorized start,
enforce the shared, sender-wide start, and sender-recipient start rates before
idempotency lookup. An idempotent start repeat counts against all three request
rates but never repeats a mailbox count or byte charge.

For `rate_limited`, calculate `retry_after_ms` from database time as the
smallest positive whole-millisecond delay after which every exceeded
applicable rolling bucket is below its limit. Use the largest required delay
when more than one bucket is exceeded, with the accepted bound of 1 through
60,000. The REST `Retry-After` and MCP error data follow the exact rules above.
If central cannot atomically read and record the shared admission state, return
`temporarily_unavailable` and perform no business operation.

## Enrollment and credential transactions

### Initial verification

Serialize consumption of one verification code. In one transaction after
DPoP validation:

1. Match the newest active enrollment-code verifier for that pending identity.
2. Require the correct purpose and unexpired lifetime.
3. Consume the code.
4. Mark the identity verified for version 2, not yet delivery-active.
5. Create one 24-hour token record bound to the proof thumbprint.
6. Commit the identity and token together.

Only after commit may the service return the token. A repeat with the same
code gets `verification_failed`, not the token again.

### Same-key reissue

Authenticate the current token and matching proof before reserving an
idempotency key. Scope that key to subject and operation `reissue.v1`. Retain
the exact successful credential result, encrypted at rest, for 48 hours.

In one transaction:

1. Find an existing result for this subject and key and return it unchanged.
2. Enforce no more than eight retained results for the identity.
3. Enforce no more than four previously unseen keys in a rolling 24 hours.
4. Enforce no more than three unexpired tokens for this identity and proof
   key, including the authenticating token.
5. Issue one token with the same `iss`, `sub`, ordered `aud`, authorization
   state, signing algorithm, and `cnf.jkt`, plus a new `jti`, `iat`, and `exp`.
6. Store the token and encrypted exact result, then commit.

The prior token remains valid until its original expiry or explicit
revocation. A limit failure returns `rate_limited` before token issuance or
result reservation. A repeat of one retained success does not consume another
new-key or active-token allowance. It still consumes one shared non-receive
request admission.

### Email-control recovery

Keep one active recovery-code verifier per identity for ten minutes. A newer
code atomically invalidates the older one. Apply no more than five code
requests and ten verification attempts per email in a rolling hour. Store rate
keys as fixed-size keyed digests rather than plaintext email. Retain at most
1,000,000 live recovery rate records across replicas. Never evict a live
record to admit another. A full store returns `temporarily_unavailable` and
sends no email, consumes no code, revokes no token, and issues no replacement.

After DPoP validation, one recovery transaction:

1. Claims the newest matching, unexpired, purpose-bound recovery code.
2. Consumes it.
3. Revokes every bearer and DPoP token for the identity.
4. Issues exactly one 24-hour DPoP token bound to the new proof key.
5. Commits code consumption, revocation, and issuance together.

After commit, send a user-visible security notice. A lost response is recovered
with another code and key. The later successful transaction revokes the token
from the lost response.

### Identity revocation

After authenticating `POST /api/v2/token/revoke`, atomically revoke every
bearer and DPoP token for the subject. Do not return `204` until every API and
MCP replica observes that revocation. A failed or uncertain transaction does
not claim success.

An ordinary `401`, invalid token, invalid proof, key mismatch, or business
failure never triggers reissue, recovery, token replacement, or bearer
fallback.

## Delivery activation

Activation is monotonic and idempotent. It applies only to a freshly enrolled
version 2 identity. In one transaction, require a valid DPoP-bound identity,
record explicit inbound version 2 opt-in, and set delivery state to `v2`.
First and repeated calls return the same exact `active` result.

Before the client observes activation success, it starts neither version 1
polling nor version 2 receive. Central therefore must not enqueue version 2
conversation turns to an inactive recipient. A target release has no version
1 mailbox inspection or migration transaction.

## Conversation and message transactions

### Start authorization and idempotency

Before reserving a request ID or exposing pressure, require all of these:

1. The recipient resolves under the published username comparison.
2. The recipient is version 2 active and has inbound conversations enabled.
3. A recipient-owned active `conversation.start` grant names the
   authenticated sender as subject.

Any failure returns the same `recipient_unavailable` result. Only an
authorized sender may learn mailbox or pair pressure.

For an authorized start, scope idempotency to authenticated sender, operation
`start.v1`, and request ID. The stored request fingerprint is HMAC-SHA-256
under a central-only rotating secret over the length-prefixed resolved
recipient agent ID and exact decoded text bytes. Do not store a plain content
digest. Retain the content-free lookup record for exactly 48 hours after first
acceptance. It contains only sender ID, request ID, creation time, status,
generated IDs, and keyed fingerprint.

In one transaction:

1. Return the existing IDs for the same logical input.
2. Reject a different recipient or text for the same idempotency identity.
3. Enforce sender, pair, rate, and recipient mailbox limits.
4. Create one conversation and first immutable turn with server-generated IDs.
5. Charge all applicable count and byte quotas.
6. Store an immutable charge ledger on the message for the recipient mailbox,
   authenticated sender, and sender-recipient pair counts and exact decoded
   text bytes.
7. Store the start idempotency and lookup record.
8. Commit all rows and counters together.

A rejected start creates no conversation, message, mailbox charge,
idempotency success, or lookup success.

Start lookup uses the authenticated sender and request ID as its lookup key.
It never reveals another sender's record, recipient, text, or fingerprint. An
unrecorded key for that sender returns the exact `not_found` result.

### Lease receive

Allow one active receive request per identity across replicas. A second
returns `receive_in_progress`. On a timeout with no eligible work, return
`{"messages":[]}` with HTTP `200`, never `204`.

Use database time. In one transaction, select queued messages and messages
whose lease expired, ordered by creation time then message ID. Build the
oldest prefix that fits both the requested count and the exact compact UTF-8
JSON response limit of 524,288 bytes. Count every byte of the outer object,
array, commas, member names, escaping, and fields. Lease only rows present in
that exact body. Set each lease expiry to 60 seconds after transaction commit.
Do not lease the next row or skip it for younger work.

If the oldest eligible message cannot fit alone despite passing the
per-message bounds, return `temporarily_unavailable`, lease nothing, and
quarantine that contract violation for operator repair. A lost response leaves
the committed lease. The same immutable row becomes eligible after expiry.
There is no lease renewal in this contract.

### Reply

The required reply idempotency header is:

```text
reply.v1.<unpadded-base64url-sha256-of-the-UTF-8-message-id>
```

Recompute it and reject a missing or mismatched value. Scope the idempotency
identity to authenticated recipient, operation `reply.v1`, and inbound message
ID. Authorize only the immutable inbound recipient. Return `message_not_found`
for an absent or foreign message.

Store an HMAC-SHA-256 fingerprint of the exact decoded reply text under a
central-only secret. In one transaction:

1. If the same reply exists, compare its keyed fingerprint and return the
   original outbound IDs for identical text.
2. Return `idempotency_conflict` for different text under the same identity.
3. Return `message_already_terminal` if another outcome won.
4. Enforce the original sender's mailbox limits.
5. Create one outbound turn addressed to the original sender, with the same
   conversation ID and the inbound message as predecessor.
6. Record the inbound terminal outcome `replied` and reply message ID.
7. Charge the outbound recipient mailbox and store its immutable count and byte
   charge ledger. A reply is not a conversation start and receives no sender
   or sender-recipient start charge.
8. Commit all changes together.

If the target mailbox is full, return `mailbox_full` and record neither reply
nor terminal outcome.

### Completion

Scope completion idempotency to authenticated recipient, operation
`complete.v1`, and inbound message ID. In one transaction, authorize the
recipient, validate one allowed outcome and reason pair, and record that
terminal result. An exact repeat returns the first result. A different pair
returns `idempotency_conflict`. A prior reply or other terminal result returns
`message_already_terminal`. Concurrent reply and completion transactions
permit exactly one winner.

### Outcome lookup

Authorize the original sender and recipient. Every other identity receives
`message_not_found`. Return content-free state only. Do not return message or
reply text, recipient username, content fingerprints, lease details, or
provider state.

### Acknowledgement

Authorize only the immutable inbound recipient. An open message returns
`message_not_terminal`. In one transaction, a terminal message becomes
acknowledged, leaves receive eligibility, and releases every immutable charge
recorded when that message was accepted. This always releases the recipient
mailbox count and exact byte charge. For a first turn created by a conversation
start, it also releases the authenticated sender and sender-recipient pair
active-start counts and bytes. The same transaction creates or updates the
content-free tombstone. Mark the charge ledger released in that transaction so
a repeated acknowledgement returns the same `acked` result without decrementing
any counter twice, including after the body is gone.

After commit, central may delete the acknowledged inbound text. Retain the
message ID, conversation ID, participant IDs, timestamps, terminal outcome,
reply message ID, and keyed request fingerprints until identity deletion.
Message IDs remain reserved forever. The outbound reply is a separate message
and retains its text until its own recipient completes and acknowledges it.

## Fixed pressure limits

These values are part of the accepted client contract. Central must either
qualify them for production or return ADR 0025 for review before changing one.

| Resource | Limit |
| --- | --- |
| Receive hold time | 30 seconds |
| Receive lease | 60 seconds |
| Messages per receive | 100 |
| Decoded text | 262,144 UTF-8 bytes |
| Encoded receive result | 524,288 UTF-8 bytes |
| REST request body | 524,288 UTF-8 bytes |
| HTTP response body | 4 MiB |
| JSON nesting | 100 levels |
| Opaque ID | 128 ASCII bytes |
| Active unacknowledged messages per recipient | 10,000 |
| Active unacknowledged bytes per recipient | 1 GiB |
| Active unacknowledged starts per sender-recipient pair | 32 messages and 8 MiB |
| Active unacknowledged starts per sender | 1,000 messages and 256 MiB |
| Conversation starts per sender-recipient pair | 10 per rolling 60 seconds |
| Conversation starts per sender | 60 per rolling 60 seconds |
| Non-receive version 2 requests per identity | 120 per rolling 60 seconds |
| Active receive requests per identity | 1 |
| Start idempotency lookup | 48 hours |

The authenticated admission section defines the one REST and MCP
non-receive counter, idempotent-repeat charging, and denied-start precedence.
Start limits are subsets of the 120-request limit rather than extra allowance.
Central never expires or cancels accepted unacknowledged work to regain
capacity. It rejects new work before a count or byte limit is exceeded.

## Application errors

Bootstrap application errors have exactly this body:

```json
{"error":{"code":"verification_failed"}}
```

| Route | HTTP | Code |
| --- | --- | --- |
| Any bootstrap route | `422` | `invalid_request` |
| Register | `409` | `registration_conflict` |
| Verify | `400` | `verification_failed` |
| Any bootstrap route | `429` | `rate_limited` |
| Any bootstrap route | `500` | `internal_error` |
| Any bootstrap route | `503` | `temporarily_unavailable` |

A bootstrap `429` includes one integer delta-seconds `Retry-After` header.
Verification's DPoP authentication errors use the flat authentication forms,
not this envelope.

After successful DPoP authentication, version 2 application errors have
exactly this shape:

```json
{"error":{"code":"rate_limited","retry_after_ms":1000}}
```

For every code except `rate_limited`, `retry_after_ms` is null. Only
`rate_limited` carries a positive whole value from 1 through 60,000 and an
integer `Retry-After` equal to `max(1, ceil(retry_after_ms / 1000))`.

| HTTP | Code | Use |
| --- | --- | --- |
| `400` | `invalid_request` | Syntax, schema, identifier, query, or value bound failed |
| `404` | `recipient_unavailable` | Recipient absent, inactive, or did not grant this sender |
| `404` | `message_not_found` | Message absent or caller cannot access it |
| `409` | `idempotency_conflict` | One idempotency identity received different logical input |
| `409` | `message_already_terminal` | Reply or completion followed another terminal result |
| `409` | `message_not_terminal` | Acknowledgement preceded terminal outcome |
| `409` | `receive_in_progress` | Another receive is active for this identity |
| `409` | `protocol_mismatch` | Identity is not active on version 2 |
| `413` | `request_too_large` | Body exceeded the fixed request limit |
| `429` | `mailbox_full` | Accepting a new message would exceed a count or byte quota |
| `429` | `rate_limited` | Authenticated caller exceeded a fixed request rate |
| `503` | `temporarily_unavailable` | Central cannot safely complete the operation |

Recipient policy and object ownership use the two non-enumerating `404`
results instead of `403`. ADR 0026 reserves `403` for a broad authorization
denial after successful DPoP authentication, but no route in this
specification assigns a `403` application code. If central needs one, it must
publish a fixed machine-readable code for contract review first. It must never
turn a recipient or object existence check into an oracle.

## Storage and observability requirements

Central storage must support these durable concepts. Names and physical layout
are implementation-owned.

- identities, verified email control, username uniqueness, delivery state,
  inbound opt-in, and recipient-owned grants;
- purpose-bound code verifiers and bounded recovery rate records;
- token IDs, subjects, key thumbprints, expiry, authorization state, and
  revocation;
- encrypted reissue idempotency results;
- conversations, immutable unacknowledged message bodies, predecessor links,
  lease time, terminal outcomes, acknowledgement, and permanent ID
  reservation;
- start, reply, and completion idempotency identities and keyed request
  fingerprints;
- mailbox count and byte accounting; and
- shared proof replay claims and nonce key-ring state.

Keep these retention classes separate. Do not use one cleanup job or expiry
column for all idempotency records:

| Record | Retention |
| --- | --- |
| Conversation-start lookup and keyed input fingerprint | Exactly 48 hours after first acceptance, then delete |
| Encrypted reissue result | Exactly 48 hours after first issuance, then delete |
| Recovery rate record | One rolling hour |
| Proof replay digest | 65 seconds after first acceptance |
| Unacknowledged message body and immutable routing | Until terminal acknowledgement, without a retention expiry |
| Reply and completion idempotency identity and keyed input fingerprint | With the acknowledged message tombstone until identity deletion |
| Acknowledged message tombstone with participants, conversation, outcome, reply ID, and timestamps | Until identity deletion |
| Global message-ID reservation | Forever, including after either participant or its detailed tombstone is deleted |

Identity deletion may remove the participant-bearing message tombstone and its
reply or completion fingerprint. It must leave a separate global reservation
for every message ID, sufficient to prevent reuse but containing no identity,
conversation, content, outcome, or fingerprint data. ID allocation and this
reservation use one transaction so a crash cannot expose a generated ID for
later reuse.

A keyed fingerprint record identifies the key version that created it. For a
48-hour record, retain that key until the record expires. For a reply or
completion record with no fixed expiry, either retain its key until identity
deletion or transactionally recompute the HMAC under a new key while the exact
content remains available. Never delete the only key able to compare a live
idempotency record, and never replace a keyed fingerprint with a plain content
digest.

The database or shared state must provide atomic compare-and-create,
conditional update, stable ordering under concurrency, database time, and
transactions spanning each set of effects named in this document. A
process-local lock, replay cache, receive flag, rate counter, token-revocation
cache, or lease clock is insufficient when two replicas can handle the same
identity.

Do not put access tokens, proofs, private keys, nonces, verification or
recovery codes, authorization headers, message or reply bodies, emails, or
request bodies in normal logs, metrics, traces, diagnostics, crash artifacts,
support bundles, or shared HTTP caches. Necessary central business storage for
identity email and unacknowledged message content is not a logging exception.
Protect it under the central data-retention and access-control policy.

Store codes as verifiers, email rate keys as keyed fixed-size digests, and
content idempotency comparisons as HMAC fingerprints under managed
central-only secrets. Encrypt credential-bearing reissue results at rest.
Secret rotation must retain enough prior material to verify every live code,
fingerprint, nonce, and idempotency record until its defined expiry or
tombstone lifetime.

Safe operational data includes operation names, fixed error codes, aggregate
counts, bounded durations, and opaque IDs only where the production logging
policy permits them. Do not log a DPoP `htu` by copying an untrusted header or
full request URL. Never log query values, proof claims, JWT claims, or body
excerpts on parsing failure.

## Proxy and external URI rules

DPoP compares the gateway's public URI with the resource server's reconstructed
public URI. Configure the public proxy and every resource server as one
security boundary:

1. The edge removes client-supplied forwarding fields.
2. The edge adds canonical external scheme, host, and port values.
3. The application trusts those values only from explicitly configured proxy
   peers.
4. A direct or untrusted peer cannot alter external URI reconstruction.
5. Internal HTTP, default ports, or query strings do not change `htu`.
6. API and MCP paths preserve case, reserved characters, repeated slashes,
   and trailing slash behavior required by the normalization profile.
7. The proxy permits the accepted credential and total-header sizes, rejects
   larger requests, does not redirect a target route, and does not log or
   cache protected headers or bodies.

Run the same URI vectors directly and through the production-like proxy. A
proxy mismatch fails before S07.

## Rollout controls

Use server-owned controls that are absent from the public API. The exact
configuration mechanism belongs to central, but it must enforce these states:

| State | Issuance | DPoP resource validation | Activation and v2 traffic |
| --- | --- | --- | --- |
| Disabled | No production DPoP issuance | Existing v1 behavior only | Rejected |
| Development | Enabled only for dedicated fresh identities | Enforced on every API and MCP request for those tokens; bearer rejected | Enabled only for the same dedicated identities |
| Staging | Enabled for disposable staging identities | Enforced through the real proxy and shared state | Full S02 through S06 contract enabled |
| Production | Enabled for approved fresh identities | Enforced everywhere before dispatch | Enabled only after S07 approval |

Do not create a state that issues a DPoP-bound token while any protected API or
MCP path accepts that token as bearer. Do not enable activation before DPoP
enforcement. Do not enqueue version 2 traffic before activation succeeds.

A rollback stops new DPoP enrollment and new version 2 activation first. It
continues DPoP enforcement for every issued token and preserves accepted
message, lease, idempotency, outcome, and acknowledgement state. If central
cannot safely serve existing version 2 identities, fail closed with
`temporarily_unavailable`. Never downgrade a version 2 token or identity to
bearer or consuming version 1 delivery.

## Work packages S01 through S07

### S01: red central contract suite

Add the server-owned tests before production behavior. Run them against the
real issuer and application boundaries with controllable clocks and response
loss. Include two replicas sharing the production-equivalent database and
security state. Publish a failure inventory that maps every red assertion to
S02 through S06. The central owner reviews and accepts the inventory before
behavior work starts.

Required groups:

- exact bootstrap and version 2 routes, strict schemas, errors, limits, and
  current version 1 regression;
- independent DPoP signature, thumbprint, URI, nonce, replay, revocation, and
  bearer-rejection vectors;
- enrollment, recovery, reissue, and revocation transactions;
- two-replica start, lease, reply, completion, outcome, acknowledgement,
  quota, and rate races;
- native MCP schemas and results with per-request transport authentication;
- trusted and spoofed proxy paths; and
- response-loss, process-kill, persistence-failure, and forbidden-artifact
  scans.

Completion evidence is the reviewed red inventory in the central repository.
Fixture results from this repository do not satisfy S01.

### S02: REST enrollment and native MCP contracts

Implement and publish the exact bootstrap routes and schemas. Publish the
version 2 REST OpenAPI contract and native MCP tool input and output schemas.
Keep issuance and version 2 work behind disabled server controls until S03
enforces DPoP. Preserve the version 1 regression separately.

Completion evidence:

- bootstrap status, schema, error, privacy, no-store, and response-loss tests
  pass;
- email comparison, ten-minute code expiry, per-code attempts, keyed verifier,
  dummy comparison, and key rotation pass at boundaries;
- every target MCP result is native structured JSON and has no token argument;
- MCP request, result, response, session, concurrency, batch, and JSON-RPC
  error boundaries pass;
- a target route `404` causes no server-side legacy alias or fallback; and
- the production-facts record names the candidate canonical origins, issuer,
  audiences, username and email comparison, and signing policy.

### S03: DPoP issuer and resource enforcement

Implement issuance proof validation, key-bound JWT issuance, protected REST
and `/mcp` validation, stateless nonces, shared replay rejection, revocation
checks, trusted external URI reconstruction, and exact authentication errors.
Enable them first for dedicated development identities.

Completion evidence:

- bearer use, wrong key, wrong `ath`, wrong URI, wrong method, replay on the
  same replica, replay across two replicas, expired or future proof, nonce
  scope mismatch, invalid token, and revoked token all fail before dispatch;
- invalid floods allocate no nonce or replay rows;
- exact nonce MAC vectors, header limits, and replay capacity boundaries pass;
- every MCP HTTP request requires a fresh proof; and
- a DPoP-bound token cannot reach any version 1 bearer or MCP token-argument
  path.

### S04: leased delivery and acknowledgement

Implement monotonic fresh-identity activation, immutable message custody,
stable bounded receive packing, 60-second shared leases, one active receive,
terminal-only acknowledgement, content deletion after acknowledgement, and
content-free tombstones.

Completion evidence:

- a receive response lost after commit redelivers the identical message after
  60 seconds;
- two replicas cannot lease the same message during one live lease;
- count and byte packing leases only the returned oldest prefix;
- an open message cannot be acknowledged;
- acknowledgement releases mailbox, sender, and sender-recipient charges in
  one transaction, and repetition releases none twice;
- repeated acknowledgement returns the same result after text deletion;
- message IDs remain globally reserved after identity deletion; and
- no accepted unacknowledged message expires to recover capacity.

### S05: conversations, replies, outcomes, and completion

Implement recipient opt-in and grants, non-enumerating start authorization,
linear conversations, start lookup, keyed idempotency, sender and mailbox
pressure, one reply, terminal completion, and content-free outcome lookup.

Completion evidence:

- identical starts and replies return their first IDs across replicas;
- changed logical input conflicts without a second message;
- reply and completion races produce one terminal winner;
- a lost reply or completion response resolves through outcome lookup;
- reply routing comes only from the immutable inbound record;
- denied starts and foreign message operations reveal no recipient or object
  existence; and
- the shared REST and MCP non-receive rate admits the first 120 requests,
  charges idempotent repeats, and preserves denied-start precedence; and
- all accepted and rejected operations update quotas atomically.

### S06: token lifecycle and email-control recovery

Implement same-key reissue, encrypted retained results, active-token and rate
limits, generic recovery-code resend, atomic revoke-and-issue recovery, and
identity-wide revocation.

Completion evidence:

- a repeated reissue key returns the byte-identical credential result, consumes
  no new token or reissue-key allowance, and still consumes one shared
  non-receive request admission;
- a new key cannot enter same-key reissue;
- lost issuance and key loss recover only through email control;
- recovery revokes every older token in the issuance transaction;
- all API and MCP replicas reject revoked tokens before revocation returns
  success; and
- known and unknown email resend behavior is indistinguishable at the public
  interface and stores no plaintext email rate key.

### S07: production-like staging gate

Deploy S02 through S06 behind the real HTTPS proxy with production-equivalent
shared state. Use dedicated fresh identities. Replace every fixture stand-in
with an owner-confirmed staging or production value. Run the black-box suite
through the public origin and canonical `/mcp` endpoint.

Completion evidence:

- the complete production-facts record is published and reviewed;
- at least two replicas pass replay, nonce, lease, idempotency, quota,
  revocation, and receive-concurrency races;
- issuer, API, MCP, and proxy URI values match the shipped gateway constants;
- a bounded outage and replica restart preserve accepted messages and
  idempotency results;
- logs, metrics, traces, caches, crash output, database exports, and support
  artifacts contain no forbidden credential, proof, nonce, code, or message
  body data outside approved central business storage; and
- the central owner records the development and production rollout decision.

S07 is staging evidence. It does not replace gateway credential, local crash,
packaged-install, connector, or platform qualification.

## Black-box acceptance matrix

Central CI should preserve these stable case IDs. The test implementation may
split a row into more cases but must keep traceability to it.

| ID | Case | Required result |
| --- | --- | --- |
| CB-V1-01 | Run the current version 1 consuming poll and MCP regression used by gateway `0.2.6` | Existing result stays unchanged; no v2 lease or DPoP behavior leaks into it |
| CB-V1-02 | Present a DPoP-bound token to a version 1 bearer or MCP token-argument path | Reject before version 1 dispatch |
| CB-BS-01 | Register at exact bounds and one over each bound | Accept the boundary, reject over-limit or unknown fields with no partial identity |
| CB-BS-02 | Repeat registration for pending email, verified email, username, and exact input | Return the same generic conflict and no matching field or agent ID |
| CB-BS-03 | Resend for pending, verified, and unknown valid email | Return indistinguishable `200`; send only the purpose-correct email for known identities |
| CB-BS-04 | Verify with missing nonce, then a valid proof and newest code | First request changes no business state; second consumes one code and returns one bound token |
| CB-BS-05 | Lose a successful verification response and repeat its code | Repeat returns generic failure; a later new-key recovery revokes the lost token |
| CB-BS-06 | Vary ASCII email case, non-ASCII bytes, dots, and plus tags | Apply only `email-comparison-v1`; all bootstrap and rate paths use the same key |
| CB-BS-07 | Exercise ten-minute pending-code expiry and ten failed attempts across two replicas | Accept before each boundary; atomically invalidate at expiry or the tenth failure |
| CB-BS-08 | Rotate the code HMAC key and verify known, unknown, and missing codes | Accept a live previous-key verifier, use timing-safe comparison including the dummy path, and store no plaintext or plain digest |
| CB-DP-01 | Exercise independent valid issuance and protected proofs | Validate ES256, P-256 JWK, RFC 7638 thumbprint, ordered audience, and `ath` |
| CB-DP-02 | Exercise every URI normalization vector directly and through the trusted proxy | Client and server derive the same exact `htu` |
| CB-DP-03 | Spoof forwarding fields from an untrusted peer | Ignore them and reject the mismatched proof before dispatch |
| CB-DP-04 | Reuse one valid proof on another replica | One request succeeds; the replay fails before business work |
| CB-DP-05 | Reach 256 live entries for one key, then submit the 257th | Preserve all live entries and return exact `dpop_rate_limited` |
| CB-DP-06 | Fill shared replay capacity | Preserve live entries and return exact `temporarily_unavailable` |
| CB-DP-07 | Test nonce bytes, encoding, scopes, key rotation, five-minute age, and five-second skew at boundaries | Accept only the exact current or retained-previous-key values |
| CB-DP-08 | Use bearer, wrong key, wrong method, wrong URI, wrong `ath`, wrong audience, expired token, or revoked token | Reject before body parsing, lease, idempotency, code use, or MCP dispatch |
| CB-DP-09 | Send missing, duplicate, malformed, and one-over-limit auth headers | Reject before JWT parsing or application work without reflecting header data |
| CB-DP-10 | Run the two fixed nonce MAC vectors and change each serialized field | Match both published nonces exactly and reject every changed grammar or tag |
| CB-MC-01 | Make every version 2 MCP HTTP request in one session | Require a fresh valid DPoP proof each time and no tool token argument |
| CB-MC-02 | Call every target MCP tool | Return native structured JSON matching the published schema and REST state |
| CB-MC-03 | Exercise every MCP byte, JSON, result, batch, and response boundary | Accept each exact limit, reject one over before dispatch, and return the fixed JSON-RPC error data |
| CB-MC-04 | Open 32 sessions and 8 tool calls, then exceed each across replicas | Admit through the exact limits; the first excess returns `temporarily_unavailable` with no extra slot |
| CB-RT-01 | Send 120 mixed REST and MCP non-receive requests, including idempotent repeats, then one more | Share one rolling counter; count repeats; return exact `rate_limited` on the first applicable excess |
| CB-RT-02 | Send a denied start while below and above the shared rate | Charge the sender once but return the same `recipient_unavailable` without pair, start, idempotency, or mailbox state |
| CB-ACT-01 | Activate one fresh DPoP identity twice | Both calls return exact `active`; no v1 inspection or migration occurs |
| CB-ACT-02 | Attempt v2 work before activation | Return `protocol_mismatch` and change no message state |
| CB-ST-01 | Start with an allowed sender and new request ID | Atomically create one conversation, first turn, lookup, and quota charge |
| CB-ST-02 | Repeat the same start, then reuse its ID with other text or recipient | Return original IDs, then exact conflict; never create a second turn |
| CB-ST-03 | Start for absent, inactive, and policy-denied recipients | Return byte-equivalent `recipient_unavailable` before pressure or idempotency checks |
| CB-ST-04 | Lose start response, query before 48 hours, then expire lookup | Return original IDs before expiry; delete the record at exactly 48 hours |
| CB-ST-05 | Reach pair, sender, mailbox, byte, and rate boundaries from two replicas | Reject the first over-limit start with no partial rows or charges |
| CB-RX-01 | Receive multiple eligible rows around count and byte limits | Return and lease only the oldest fitting prefix in stable order |
| CB-RX-02 | Lose receive response after lease commit | Hide rows for 60 seconds, then return identical logical messages |
| CB-RX-03 | Race receive through two replicas | At most one result contains a row during its lease |
| CB-RX-04 | Start a second receive for one identity | Return `receive_in_progress` and acquire no lease |
| CB-RX-05 | Keep an unacknowledged message beyond maintenance and retention jobs | Preserve its immutable body and keep redelivering after lease expiry |
| CB-RP-01 | Reply, repeat identical text on another replica, then repeat different text | Create one outbound turn, return one ID, then conflict |
| CB-RP-02 | Fill original sender mailbox before reply | Return `mailbox_full`; keep inbound open with no reply or terminal result |
| CB-RP-03 | Race reply and each completion outcome | Record one terminal winner and no orphan outbound message |
| CB-OC-01 | Record every allowed outcome and exact repeat | Return one recorded result; reject disallowed pairs and conflicting repeats |
| CB-OC-02 | Lose a reply or completion response | Outcome lookup returns the exact terminal content-free state |
| CB-OC-03 | Inspect outcome as sender, recipient, and foreign identity | Permit participants; return `message_not_found` to the foreign identity |
| CB-AK-01 | Acknowledge open, terminal, and already acknowledged messages | Reject open; atomically release exact mailbox and applicable start charges; return the same ack without a second release after body deletion |
| CB-TK-01 | Reissue with one key and repeat after response loss | Return byte-identical token result, one token issuance, and one retained result |
| CB-TK-02 | Exercise four new reissue keys, eight retained results, and three active tokens at boundaries | Accept through each limit and reject the first excess without eviction |
| CB-TK-03 | Try reissue with another key, invalid token, expired token, or bearer | Reject before issuance and do not enter recovery automatically |
| CB-RC-01 | Reach recovery code and attempt limits across replicas | Enforce one live code, five requests, ten attempts, one-hour expiry, and no identity oracle |
| CB-RC-02 | Recover with a new proof key after token or key loss | Atomically consume code, revoke every old token, and issue one new bound token |
| CB-RV-01 | Revoke an identity while API and MCP requests race on two replicas | Return `204` only after all later requests reject every old token |
| CB-ER-01 | Trigger every bootstrap, authentication, and v2 application error | Return the exact status, envelope, headers, and no-store policy without prose or secrets |
| CB-CR-01 | Kill a replica or lose a response at each transaction boundary | Commit all named effects or none; retries and lookups converge to one logical result |
| CB-ID-01 | Expire each retention class and then delete both message participants | Delete only the due class; preserve a content-free global message-ID reservation forever |
| CB-CE-01 | Inspect every target REST JSON success and error | Find no `Content-Encoding`; preserve the exact JSON media type and no-store rules |
| CB-SC-01 | Scan proxy, service, database diagnostics, queues, caches, logs, metrics, traces, crash output, and support artifacts | Find no forbidden data outside the explicitly approved central business records |

## S01 failure inventory format

For each red case, record:

| Field | Required value |
| --- | --- |
| Case ID | One stable ID from the matrix or a documented child ID |
| Current result | Exact status, state change, or missing interface observed |
| Target result | Exact required result from this specification |
| Owning package | S02, S03, S04, S05, or S06 |
| Replica mode | Single replica, two replicas, proxy, or all applicable modes |
| Data check | State rows and forbidden-artifact locations inspected |
| Review | Central owner name, date, and acceptance reference |

Do not mark a case green by changing a fixture value or weakening an expected
result. A production constraint that requires a client-visible change goes
back to the relevant ADR and gateway review.

## Definition of done

S01 through S07 are complete only when:

- the central repository contains the reviewed red inventory and green tests;
- the published REST and MCP schemas match this contract;
- DPoP-bound tokens fail through every bearer path;
- two-replica and trusted-proxy tests pass with production-equivalent shared
  state;
- all named transactions are atomic under response loss and process failure;
- current version 1 behavior remains protected by separate regression tests;
- version 2 uses only fresh identities and contains no migration or runtime
  negotiation path;
- the production-facts record contains no fixture stand-in; and
- staging black-box evidence and the central-owner rollout decision are
  available to the gateway release review.
