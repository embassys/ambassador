# 0026 DPoP-bound central tokens

Status: accepted

Date: 2026-08-29

Approved: 2026-08-29

Version 1 credential migration and in-place-upgrade requirements are
superseded by accepted ADR 0027. The future gateway is fresh-install-only.

## Problem

The gateway currently receives a central JWT from `verify_email`, stores it in
an encrypted file, places it in the REST polling bearer header, and injects it
as a `token` argument for authenticated central MCP tools. Anyone who obtains
that JWT can use it until it expires or is revoked.

Encrypting the JWT at rest does not constrain a copied token to this gateway.
DPoP can add that constraint, but only when the token issuer binds the token to
a gateway-held public key and every protected resource rejects requests that do
not prove possession of the matching private key. Generating proofs in the
gateway while the server continues to accept the JWT as a bearer token would
not add this protection.

DPoP is an HTTP authentication mechanism. It cannot be implemented correctly
by adding a proof or token to MCP tool arguments. The central MCP service must
authenticate the HTTP transport request before dispatching any JSON-RPC or tool
operation.

## Security objective

Use RFC 9449 DPoP to sender-constrain every newly issued central JWT to one
asymmetric key held by the gateway. A stolen JWT without that private key must
not authorize REST or central MCP requests.

This does not replace HTTPS, protect a gateway process that can use the private
key, sign request bodies or query values, or protect against theft of both the
encrypted credential and its local decryption secret. The existing credential
storage, endpoint binding, local MCP authentication, input validation, and data
boundary remain necessary.

## Decision

Adopt a narrow RFC 9449 profile for the current custom email-verification token
flow. This is not a claim that the service implements a complete OAuth
authorization server. If central later adopts OAuth authorization-server
metadata, it should publish `dpop_signing_alg_values_supported` under RFC 8414.
The gateway must not add runtime discovery to use DPoP.

The first profile pins:

- `ES256` with a P-256 key pair;
- a public EC JWK in each proof JWT header;
- an RFC 7638 SHA-256 JWK thumbprint in the access token's `cnf.jkt` claim;
- one fresh proof and `jti` for every HTTP request;
- the `DPoP` authorization scheme for every protected central request;
- mandatory server nonces at token issuance and protected resources;
- a 60-second proof acceptance window with 5 seconds of future clock skew;
- 24-hour access tokens with DPoP-authenticated same-key reissue; and
- email-control re-verification for key rotation, key loss, and bearer-token
  migration.

Node's approved cryptographic facilities can generate and use this key. The
gateway must not install another cryptographic, JWT, OAuth, or HTTP dependency
without a separate dependency decision.

## Gateway proof format

Each proof is a short-lived signed JWT. Its protected header is:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "<base64url-x-coordinate>",
    "y": "<base64url-y-coordinate>"
  }
}
```

The protected header contains exactly these three members and no unprotected
header. The JWK contains exactly `kty`, `crv`, `x`, and `y`. Each coordinate is
the unpadded base64url encoding of 32 bytes. The header contains no private `d`
value, symmetric key, `kid`, certificate reference, or remote key URL.

An issuance proof contains:

```json
{
  "jti": "<new-uuid-v4>",
  "htm": "POST",
  "htu": "https://central.example/api/verify_email",
  "iat": 1788000000,
  "nonce": "<server-nonce-when-challenged>"
}
```

A protected-resource proof also contains:

```json
{
  "ath": "<base64url-sha256-of-the-ASCII-access-token>"
}
```

The payload contains only the fields shown above. An issuance proof omits
`ath`. A protected-resource proof requires it. Both require `nonce` under this
profile before central accepts them. A request without a cached nonce may omit
that claim only to obtain the first challenge, and central never dispatches
such a request. The gateway creates `jti` as a lowercase canonical UUID v4 and
`iat` as an integer NumericDate from its current wall clock. Every request and
every retry gets a new proof, `jti`, and `iat`.

`htu` is the externally visible absolute target URI without query or fragment.
For example, a receive call to
`https://central.example/api/v2/messages/receive?timeout=30&limit=100` signs
`https://central.example/api/v2/messages/receive`. The client and server
normalize the URI according to RFC 3986 Sections 6.2.2 and 6.2.3 before exact
comparison:

- lowercase the scheme and host;
- remove the default port for the scheme;
- uppercase hexadecimal digits in percent encodings and decode percent-encoded
  unreserved characters;
- remove dot segments;
- represent an empty HTTP path as `/`; and
- preserve path case, reserved characters, consecutive slashes, and a trailing
  slash.

The client uses the approved canonical external endpoint as its input. The
server reconstructs that same external URI from its request target and trusted
proxy configuration. Neither side includes a query or fragment. `htm` is the
case-sensitive HTTP method from the request, such as `GET`, `POST`, or
`DELETE`.

## Required server interface

This profile freezes the route split accepted by ADRs 0023 and 0025:

| Purpose | Exact route |
| --- | --- |
| Registration | `POST /api/register` |
| Verification and DPoP issuance | `POST /api/verify_email` |
| Verification-code resend and recovery-code request | `POST /api/resend_verification` |
| Protected version 1 polling during its supported lifetime | `GET /api/poll_messages` |
| Start conversation | `POST /api/v2/conversations` |
| Resolve uncertain conversation start | `GET /api/v2/conversation-starts/{request_id}` |
| Receive messages | `GET /api/v2/messages/receive` |
| Reply | `POST /api/v2/messages/{message_id}/reply` |
| Record terminal outcome | `POST /api/v2/messages/{message_id}/complete` |
| Inspect outcome | `GET /api/v2/messages/{message_id}/outcome` |
| Acknowledge | `POST /api/v2/messages/{message_id}/ack` |
| Activate version 2 delivery | `POST /api/v2/delivery/activate` |
| Same-key token reissue | `POST /api/v2/token/reissue` |
| Identity token revocation | `POST /api/v2/token/revoke` |
| Streamable HTTP MCP | `/mcp` |

The three bootstrap routes remain unversioned because they match the supplied
enrollment contract. New protected REST work uses `/api/v2`. The gateway does
not probe another version, retry on a legacy path, or fall back between REST
and MCP after a route or transport failure.

The central MCP URL remains the existing stable `/mcp` endpoint. API version 2
does not create `/api/v2/mcp`, `/mcp/v2`, or another MCP transport path. A
future MCP endpoint change requires a separately approved coordinated release
and credential migration because ADR 0019 authenticates the canonical central
API and MCP endpoint pair as credential-file additional data. Changing the
authenticated pair without that migration makes an existing credential
unreadable by design.

### Token issuance through verification

`POST /api/verify_email` becomes the token-issuance operation for this profile:

```http
POST /api/verify_email HTTP/1.1
Host: central.example
Content-Type: application/json
DPoP: <issuance-proof>

{"email":"test@example.com","code":"123456"}
```

The proof has no `ath` because the request does not yet carry an access token.
The server must validate the proof before consuming the verification code or
marking the email verified. It then computes the RFC 7638 thumbprint of the
proof key and binds the new JWT to it.

The successful response extends the accepted REST enrollment response:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "token": "<central-jwt>",
  "token_type": "DPoP",
  "expires_in": 86400,
  "message": "Email verified"
}
```

The JWT payload must contain:

```json
{
  "iss": "<canonical-central-issuer>",
  "aud": ["<central-api-resource>", "<central-mcp-resource>"],
  "sub": "agent_123",
  "iat": 1788000000,
  "exp": 1788086400,
  "jti": "<lowercase-uuid-v4-token-id>",
  "cnf": {
    "jkt": "<base64url-rfc7638-sha256-thumbprint>"
  }
}
```

The token lifetime is 86,400 seconds. `expires_in` must be `86400`, `exp - iat`
must be `86400`, and `sub` must equal `agent_id`. `aud` is an array containing
exactly the canonical API resource and canonical MCP resource, in that order,
with no additional audience. The JWT may contain the service's bounded
authorization claims, but it must not contain an email, verification code,
private key, proof, or nonce. Central validates the JWT signature, issuer,
audience, subject, token `jti`, time, revocation state, and authorization claims
on every protected request.

`token_type` is required and must be `DPoP`. The gateway rejects and does not
persist a verification response with a missing or different token type,
`expires_in` other than `86400`, a malformed JWT, an inconsistent lifetime, a
missing `cnf.jkt`, or a thumbprint that differs from its generated public key.
The gateway checks these response invariants but does not treat decoding the
JWT as signature verification. The resource servers remain responsible for
cryptographic JWT validation.

Successful and failed verification responses must include a
`Cache-Control: no-store` header. The central service, reverse proxy, and
observability pipeline must not cache or log verification bodies,
authorization headers, proofs, nonces, or JWT claims.

Registration and verification-code resend remain bootstrap operations without
a central access token. They do not carry an `Authorization` or `DPoP` header
because they neither issue nor consume a protected token. Verification always
carries an issuance proof because it issues a token.

### Protected REST requests

Every central REST route that currently accepts the JWT as bearer
authentication must instead accept this pair:

```http
GET /api/v2/messages/receive?timeout=30&limit=100 HTTP/1.1
Host: central.example
Authorization: DPoP <central-jwt>
DPoP: <protected-resource-proof>
```

The proof uses `htm` `GET`, the receive URL without its query, and an `ath` value
calculated as base64url without padding of SHA-256 over the ASCII JWT value.
Every other protected `/api/v2` route uses the same headers with its own method
and target URI. Legacy `/api/poll_messages` remains part of the version 1
migration surface and never accepts a DPoP-bound token through its bearer path.

The access-token value may contain at most 4,096 ASCII bytes. The DPoP proof
may contain at most 4,096 ASCII bytes. The complete `Authorization` field value,
including `DPoP` and its one separating space, may contain at most 4,101 ASCII
bytes. The complete `DPoP` proof field value may contain at most 4,096 ASCII
bytes, so those two field values may contain at most 8,197 bytes in total.
Central rejects an over-limit field before JWT decoding. Its proxy and
application header limits must permit this profile without permitting more
than the reviewed total request-header limit of 16 KiB.

The server must reject all of these cases before application dispatch:

- `Bearer <dpop-bound-token>`;
- a missing, repeated, or malformed `Authorization` or `DPoP` header;
- an unapproved algorithm or invalid signature;
- a private or symmetric JWK in the proof header;
- a wrong `typ`, `htm`, `htu`, `iat`, `nonce`, or `ath`;
- a proof key whose RFC 7638 thumbprint differs from the token's `cnf.jkt`;
- a repeated proof `jti` inside the acceptance window; or
- an otherwise expired, revoked, wrong-audience, or unauthorized JWT.

Bearer tokens retained temporarily for migration must remain distinguishable
from DPoP-bound tokens. A DPoP-bound token must never enter the legacy bearer
validation path.

### Protected central MCP transport

Every gateway-to-central Streamable HTTP request must carry a fresh DPoP proof:

```http
POST /mcp HTTP/1.1
Host: central.example
Authorization: DPoP <central-jwt>
DPoP: <proof-for-POST-and-the-canonical-mcp-url>
Content-Type: application/json
```

This applies to initialization, tool catalog, tool calls, notifications,
session termination, and any GET reconnect request, using the actual method for
each request. A shared MCP session does not make later HTTP requests
authenticated.

The central MCP tool schemas must remove the `token` input field. The gateway
must stop injecting a token into tool arguments and authenticate through the
HTTP transport instead. Local MCP schemas still reject all credential-shaped
arguments and results. Tool availability still depends on the gateway having a
valid stored identity.

This is a project-specific central MCP authorization profile. The current MCP
authorization specification requires `Authorization: Bearer` on each HTTP
request and does not define DPoP. This profile therefore does not claim
conformance with MCP's standard OAuth authorization flow. It keeps Streamable
HTTP and JSON-RPC behavior unchanged while replacing the current nonstandard
tool-argument token with RFC 9449 transport authentication. Moving later to the
MCP OAuth authorization profile requires a separate discovery, audience,
client, token-endpoint, and DPoP interoperability decision.

All version 2 MCP methods continue through `/mcp` and share the same central
state and authorization rules as their REST counterparts. The message protocol
version is an identity property, not an MCP transport-path version.

### Nonce challenges

The server requires a nonce for every issuance proof and protected-resource
proof. A request without a current nonce receives a challenge before any
application work. The token-issuance response is:

```http
HTTP/1.1 400 Bad Request
DPoP-Nonce: <opaque-nonce>
Content-Type: application/json

{"error":"use_dpop_nonce"}
```

A protected-resource challenge is:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: DPoP error="use_dpop_nonce"
DPoP-Nonce: <opaque-nonce>
```

The nonce is opaque to the gateway. Central uses a stateless authenticated
format so a challenge does not create attacker-controlled database rows. The
decoded value is exactly 57 bytes:

```text
version:    1 byte, value 1
issued_at:  8-byte unsigned big-endian Unix time
random:     16 bytes from the operating-system cryptographic random source
tag:        32-byte HMAC-SHA-256
```

Central sends the 76-character unpadded base64url encoding of those bytes and
returns exactly one `DPoP-Nonce` field. The tag covers a fixed
`a2a-dpop-nonce-v1` domain separator, the issuance or resource scope, the
canonical security-domain identifier, the binding values, and the first 25
nonce bytes with unambiguous length prefixes. An issuance nonce binds the
proof-key thumbprint and issuer security domain. A resource nonce binds the
token subject, proof-key thumbprint, and resource security domain. The tag is
invalid if any bound value changes.

Every replica uses the same managed nonce-MAC key ring. The ring contains at
most a current and previous key. Central rotates the key no more often than
once per 24 hours and retains the previous key for five minutes and five
seconds after rotation. It accepts a correctly authenticated nonce for five
minutes after `issued_at` and allows no more than five seconds of future clock
skew. Nonce validation allocates no per-nonce or per-key server record.

Central sends a fresh nonce on every challenge. After successful DPoP
authentication, it also sends a replacement when the presented nonce is at
least four minutes old. Any response carrying `DPoP-Nonce` also carries
`Cache-Control: no-store`. Central rejects a missing, malformed, expired, or
wrong-scope nonce before consuming a verification code, reserving an
idempotency key, dispatching an MCP method, or performing another application
side effect.

The gateway accepts only the exact 76-character base64url form. It keeps at
most one nonce for each fixed approved issuer, API, and MCP security domain,
with a maximum of three entries. It never persists or logs them. The
five-minute server window makes replacement safe when concurrent responses
arrive in a different order.

On one syntactically valid `use_dpop_nonce` challenge, the gateway repeats the
request once with the supplied nonce, a new proof, and a new `jti`. This retry
is safe only because the server contract says the challenge precedes all
application dispatch. A second challenge, malformed challenge, timeout,
connection loss, ordinary authentication failure, or application error does
not trigger this retry. Other retries follow the operation-specific rules
below.

### Other errors

An invalid issuance proof returns HTTP 400 with:

```json
{"error":"invalid_dpop_proof"}
```

An invalid protected-resource proof returns HTTP 401 with a DPoP
`WWW-Authenticate` challenge and `error="invalid_dpop_proof"`. An invalid,
expired, or revoked access token returns HTTP 401 with `error="invalid_token"`.
Authorization failure after successful authentication remains a separate 403
application error.

The proof-key replay-rate limit returns HTTP 429, an integer delta-seconds
`Retry-After`, and the flat body `{"error":"dpop_rate_limited"}`. Exhausted
shared authentication capacity returns HTTP 503 with the flat body
`{"error":"temporarily_unavailable"}`. Both responses include
`Cache-Control: no-store`. The gateway does not automatically retry either
response.

After successful authentication, a broad authorization denial may use HTTP
403. ADR 0025's anti-enumeration rules remain deliberate exceptions. Starting
a conversation returns the same HTTP 404 `recipient_unavailable` response when
the recipient is absent, has not opted in, or does not permit the sender. An
object-scoped message operation returns HTTP 404 `message_not_found` when the
message is absent or the caller does not own it. Central does not use 403 for
either anti-enumeration case. DPoP middleware must preserve these application
results rather than converting them into `invalid_token` or a broad 403.

The gateway maps these results to fixed local errors. It never reflects the
remote proof, nonce, token, response body, header values, or URL.

## Server validation and state requirements

The token issuer must:

1. require one issuance proof on verification;
2. verify the JOSE header, signature, claims, method, target URI, time, and
   nonce;
3. compute the public-key thumbprint using RFC 7638 canonical EC members in
   `crv`, `kty`, `x`, `y` order;
4. place that thumbprint in the signed JWT's `cnf.jkt` claim;
5. return `token_type` `DPoP`; and
6. never issue or return the token if proof validation fails.

Every resource server, including the MCP HTTP endpoint, must:

1. validate the central JWT by its normal signature and authorization rules;
2. require the `DPoP` authorization scheme for a token with `cnf.jkt`;
3. validate the proof and match its key to `cnf.jkt`;
4. validate `ath`, `htm`, `htu`, `iat`, and nonce;
5. atomically reject replayed proofs inside the acceptance window; and
6. complete those checks before parsing or dispatching an application body.

The server accepts a proof only when its integer `iat` is no more than 60
seconds old and no more than 5 seconds in the future according to the receiving
server. Proof and token IDs use the lowercase UUID v4 form
`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
After all other authentication checks and before application dispatch, the
server atomically claims this replay key:

```text
SHA-256(security-domain || 0x00 || jkt || 0x00 || htm || 0x00 || normalized-htu || 0x00 || jti)
```

The server keeps the fixed 32-byte digest for 65 seconds after first
acceptance. A duplicate claim fails authentication. The shared replay store
allows at most 256 live digests for one proof-key thumbprint and security
domain, and at most 1,000,000 live digests in one security domain. The limits
include every replica. A 257th distinct, otherwise valid proof for one key
returns 429 with `dpop_rate_limited`. If the security-domain capacity is full,
central returns 503 with `temporarily_unavailable`. Neither result dispatches
the application request. Central never evicts an unexpired digest to admit a
new one.

Replay state must work across all replicas that can receive a request. A
process-local cache behind a load balancer is not sufficient. Central may use a
shared atomic store or an equivalent design, but the deployment owner must
confirm its fixed capacity and expiry behavior. A proof allocates a replay
entry only after its signature, claims, key binding, token, and authenticated
stateless nonce have passed validation. Invalid proof and nonce floods
therefore create no replay or nonce records.

A reverse proxy must reconstruct the external HTTPS URI used by the gateway.
It trusts forwarded scheme, host, and port values only from an explicitly
configured proxy peer. It removes untrusted forwarding fields before adding
its own. Internal HTTP routing, a query string, or a default port must not make
the gateway and server calculate different `htu` values. Tests run the same
vectors against direct central requests and the production proxy path.

Duplicate JSON members, unknown JOSE header members, unknown proof claims,
invalid UTF-8, noninteger NumericDate values, and trailing data fail before
signature or application processing. The server bounds and parses the proof
before allocating replay or nonce state.

## Token reissue and revocation

The 24-hour token lifetime requires a renewal operation that does not expose
email codes during normal operation. Central adds this same-key reissue route:

```http
POST /api/v2/token/reissue HTTP/1.1
Host: central.example
Authorization: DPoP <current-central-jwt>
DPoP: <proof-signed-by-the-current-key>
Idempotency-Key: <lowercase-uuid-v4>
Content-Type: application/json

{}
```

The server authenticates the current token and proof before reserving the
idempotency key. It issues a new JWT with the same `iss`, `sub`, exact ordered
`aud` value, authorization state, JOSE signing `alg`, and `cnf.jkt`, a new token
`jti`, and a new 24-hour lifetime. The proof key and `ES256` proof algorithm do
not change. The response uses the verification token fields, omitting identity
prose:

```json
{
  "token": "<new-central-jwt>",
  "token_type": "DPoP",
  "expires_in": 86400
}
```

The route never changes the DPoP key. Central scopes the idempotency key to the
authenticated subject and operation, retains the exact successful result for
48 hours, and returns that result when the same key repeats. Reusing the key
for another subject or operation fails. Central retains at most eight reissue
idempotency results for one identity. It accepts at most four previously unseen
reissue keys for one identity in a rolling 24-hour window. Cached success for
the same key does not count again. A limit failure returns 429 `rate_limited`
with `Retry-After` before issuing a token or reserving another result.

Central permits at most three unexpired DPoP access tokens for one identity and
proof key, including the token that authenticates reissue. A new reissue that
would exceed the limit returns 429 without issuing or revoking a token. The
prior token remains valid until its original expiry unless an administrator or
recovery flow revokes it. This bounded overlap prevents a lost response or
local persistence failure from stranding a working identity without allowing
unbounded restart-driven issuance.

Every reissue response includes `Cache-Control: no-store`. The retained
idempotency result contains a credential. Central encrypts it at rest, excludes
it from logs, metrics, diagnostics, traces, and support exports, and deletes it
after 48 hours. The result never enters a shared HTTP cache.

The gateway starts reissue when the current token has 12 hours remaining. It
keeps one random idempotency key in memory until reissue succeeds or the
process stops. A valid nonce challenge permits the one immediate retry defined
above. After a timeout or connection loss, the gateway may repeat reissue with
the same idempotency key and a fresh proof after its bounded backoff because
the server contract makes that operation idempotent. It does not apply this
exception to any other side-effecting request. After restart it may use a new
idempotency key because the still-stored token remains valid and all issued
replacements remain bound to the same private key.

Reissue uses the same credential interception boundary as verification. The
gateway intercepts the successful HTTP body before generic response handling,
verbose transcript generation, local MCP result construction, or any callback
can observe it. It permits exactly one top-level `token`, extracts it, rejects
credential-shaped data elsewhere and any non-token value containing the token
bytes, then replaces the result with fixed token-free internal state. Every
error and diagnostic path redacts the token, proof, nonce, authorization
header, and private-key material. Reissue never returns a credential-bearing
local MCP result.

The gateway validates and atomically persists the replacement before using it.
If persistence fails before atomic publication, it keeps the old encrypted
record and continues with the old token while it remains valid. It never stores
a pending token or idempotency key outside the encrypted credential
transaction. An authentication failure does not trigger reissue, refresh, key
rotation, or bearer fallback. Scheduled same-key reissue and repetition of that
one idempotent operation are the only automatic token-renewal paths.

At `exp`, the gateway stops polling and rejects authenticated local tools. It
keeps the encrypted record for diagnosis but never sends the expired token or
falls back to bearer authentication. If the process remained offline through
the reissue window, the user restores access through email-control
re-verification.

Central also provides an authenticated revocation operation:

```http
POST /api/v2/token/revoke HTTP/1.1
Host: central.example
Authorization: DPoP <current-central-jwt>
DPoP: <proof-signed-by-the-current-key>
Content-Type: application/json

{"scope":"identity"}
```

After DPoP validation, this route revokes every bearer and DPoP token for the
authenticated identity and returns HTTP 204 with no body. Every API and MCP
replica must observe revocation before the 204 response is sent. If the outcome
is uncertain, the gateway keeps its local credential and reports an uncertain
reset. A later `invalid_token` response does not prove whether revocation or
another failure caused it, so the user completes email-control recovery before
the gateway deletes or replaces local credentials. The local command or tool
that authorizes intentional reset remains a separate interface decision.

## Gateway key and credential lifecycle

The gateway generates one P-256 key pair in memory immediately before a
verification attempt. It sends only the public key in the DPoP proof. After a
successful response, it validates `token_type` and `cnf.jkt`, then persists the
JWT, token type, algorithm, and private key as one atomic encrypted credential.
Only after that transaction succeeds may it enable authenticated tools or
polling.

ADR 0019's encrypted credential needs a version 2 plaintext record inside the
existing AES-256-GCM envelope. The record contains exactly these fields:

```json
{
  "credential_version": 2,
  "token_type": "DPoP",
  "access_token": "<central-jwt>",
  "dpop_alg": "ES256",
  "dpop_private_key_pkcs8": "<base64url-pkcs8-der>"
}
```

The plaintext is strict UTF-8 JSON with no duplicate or unknown fields. The
access token is limited to 4,096 ASCII bytes. The private-key field is the
unpadded base64url encoding of PKCS#8 DER for exactly one P-256 private key and
is limited to 1,024 ASCII bytes. The full plaintext is limited to 8 KiB. On
load, the gateway imports the key, derives its public JWK and thumbprint, and
requires that value to match the JWT's `cnf.jkt` before it enables authenticated
work.

The outer envelope version and its authenticated metadata also become version
2. The existing KDF, AES-256-GCM parameters, endpoint-pair scope, permissions,
symlink and hard-link checks, and durability rules remain unchanged. The outer
file continues to expose only fixed cryptographic metadata and ciphertext. The
file contains no email, username, public identity, nonce, proof, message, or
provider state. Private-key bytes, plaintext records, tokens, proofs, nonces,
and idempotency keys must not enter logs, SQLite, diagnostics, metrics,
temporary files, crash artifacts, or support bundles.

This record format and its migration supersede the JWT-only payload portion of
ADR 0019. A normal reissue may replace a valid version 2 record only
when all of these invariants pass before publication:

1. The HTTPS response has the exact success shape, `Cache-Control: no-store`,
   `token_type` `DPoP`, and `expires_in` `86400`.
2. Old and new JWTs have byte-exact equal `iss` and `sub` strings and the exact
   same ordered `aud` array.
3. Old and new JWTs have the same issuer-signing `alg`, and it is accepted by
   the fixed product validation policy.
4. Old and new `cnf.jkt` values equal the thumbprint derived from the one stored
   private key. The credential `dpop_alg` remains exactly `ES256`.
5. Both tokens have `exp - iat` equal to 86,400 seconds. The new `exp` is later
   than the old `exp`, and its `jti` differs from the old token's `jti`.
6. The canonical API and `/mcp` endpoint pair authenticated as credential-file
   additional data is unchanged.

The gateway treats any mismatch as a contract failure, publishes nothing, and
continues with the old credential while it remains usable. It does not accept a
new issuer, subject, audience, proof key, proof algorithm, token-signing
algorithm, endpoint pair, or lifetime as routine renewal. Changes to
authorization claims remain server-owned, but central must derive them from the
same identity's current grants rather than trusting reissue request data.

Normal reissue extends ADR 0019's non-replacing first-write transaction with a
same-identity compare-and-replace transaction. The gateway serializes
replacement in one process. It captures a SHA-256 digest of the current
encrypted record, writes a complete version 2 replacement to an exclusive
sibling temporary file with fresh salt and IV, syncs it, decrypts and validates
the temporary record, then reopens the current file without following links and
requires its digest, ownership, link count, and access controls to remain
unchanged. A mismatch aborts before publication.

On POSIX, the gateway preserves ADR 0019's `0700` directory and `0600` file
requirements, atomically renames the validated sibling over the exact current
file, syncs the parent directory, then reopens and validates the published
record. On Windows, it preserves the current-user-and-`SYSTEM` DACL, uses an
approved `ReplaceFileW`-equivalent all-or-nothing replacement without creating
a backup, syncs the replacement, reopens and syncs the final file, and verifies
its DACL and contents. If the approved runtime cannot provide that Windows
primitive, implementation stops for a separate dependency or platform
decision.

ADR 0033 defers that Windows implementation and qualification beyond the
initial release. The branch may remain fail-closed; only the POSIX path is
normative release behavior.

A failure before publication leaves the old record. A failure after the atomic
replace creates an uncertain durability outcome. The gateway then reloads the
published path and enables authenticated work only if exactly one complete
record passes the same identity, key, permission, endpoint, and cryptographic
checks. It never activates the response token from memory to work around an
uncertain or failed disk transaction. It never exposes or writes an unencrypted
backup. OS credential-vault storage remains a separate future improvement.

An explicit email-control recovery may replace a readable version 1 or version
2 record with a new version 2 record only when the new response has the same
`iss`, `sub`, and ordered `aud` as the readable record. Recovery deliberately
uses a new P-256 key, so it replaces `cnf.jkt` only after central atomically
revokes all old tokens. Replacing an unreadable record is not a same-identity
transaction and remains blocked on the separate user-authorized reset
interface.

A DPoP-bound token also supersedes ADR 0019's permitted transient token
locations. A DPoP-bound JWT may appear only in the `Authorization: DPoP` header
of a gateway-to-central REST or MCP request, and transiently while calculating
`ath`. It must no longer appear in an MCP tool argument. Protocol v1 and ADR
0017 require the same narrow amendment after implementation.

## Required D04 supersession

The D04 implementation package cannot rely on this ADR alone. Before
its red tests or production changes merge, it must explicitly update
`AGENTS.md`, the accepted product document, protocol v1, implementation plan,
ADR 0017, and ADR 0019 where they currently say:

- a successful `verify_email` response is the only source of a central JWT;
- the gateway never refreshes a central JWT automatically;
- a first credential cannot be replaced; and
- upstream MCP authentication carries the JWT as a `token` tool argument.

The narrow replacement contract is: verification creates the first
credential, scheduled `/api/v2/token/reissue` may replace it with an exact
same-identity and same-key credential, and explicit email-control recovery may
replace it with an exact same-identity credential bound to a new key after
server-side revocation. Scheduled reissue and its same-key idempotent retry are
the only exceptions to the current no-silent-refresh rule. A 401,
`invalid_token`, proof failure, key failure, or ordinary tool failure never
triggers refresh or replacement.

D04 must apply verification's interception, redaction, validation,
persist-before-activation, and token-free local result rules identically to a
reissue response. It must also replace the ADR 0019 first-write-only mechanics
only with the compare-and-replace transaction above. No other credential
replacement rule is implied. Until those accepted documents and tests are
coordinated, the current verification-only behavior remains authoritative and
production DPoP implementation is blocked.

## Migration and recovery

An existing bearer JWT cannot be converted into a DPoP-bound token by the
gateway. The issuer must sign a new token containing the new key thumbprint.
This decision uses email-control re-verification, not bearer-only rebinding.
A bearer-only bind route would let anyone holding a stolen bearer token bind
the account to an attacker-controlled key.

Central extends the existing resend and verification operations for an email
that already owns an identity:

1. `POST /api/resend_verification` sends a new bounded, single-use recovery
   code and returns the same generic response whether the email exists or not.
2. The gateway generates a new P-256 key and calls `POST /api/verify_email`
   with the email, recovery code, and an issuance proof for that key.
3. After validating the proof and code, central revokes every active bearer and
   DPoP token for that identity, creates one DPoP token bound to the new key,
   and returns the normal verification response.
4. The gateway replaces the old encrypted credential only after it validates
   and durably stores the new version 2 record.

Central consumes the code and changes token state in one transaction. A lost
response or local persistence failure does not make the identity unrecoverable.
The user can request a new code and repeat the flow. The later successful flow
revokes any token issued by the lost flow.

Recovery state is bounded. Central retains one active recovery-code hash per
identity for ten minutes; issuing a newer code invalidates the older code. It
allows at most five code requests and ten verification attempts per email in a
rolling hour, applies the same observable response to known and unknown
syntactically valid emails, and stores rate keys as fixed-size keyed digests
rather than email addresses. Rate records expire after one hour. The shared
store retains at most 1,000,000 live rate records across replicas and never
evicts a live record to admit another. A full store fails closed with
`temporarily_unavailable` and does not send email, consume a code, revoke a
token, or issue a replacement. Successful recovery revokes every old token in
the issuance transaction, then leaves exactly one active DPoP token for the
identity and new key.

This same operation handles deliberate key rotation, a lost or corrupt private
key, a changed webhook-token decryption secret, and version 1 bearer migration.
An unreadable local record still requires the separate user-authorized reset
interface listed for later review before the gateway may replace its file. The
operation proves current email control before changing the key. The server
rate-limits requests without revealing whether an email exists and sends a
user-visible security notice after successful recovery.

When the gateway opens a version 1 credential during the migration window, it
does not use that bearer token. It enters `migration_required` and exposes only
the existing resend and verification tools needed for email-control recovery.
It never derives a key from the bearer token or sends that token with the
recovery request. Version 1 cannot be upgraded locally.

After the migration deadline, central rejects all legacy bearer tokens and the
gateway rejects version 1 records with a fixed migration-required error. The
gateway never falls back from a DPoP token to bearer authentication after a
proof, key, expiry, or revocation failure.

## Rollout order

1. The contract, limits, storage record, and migration are approved.
2. Both independent central fixtures implement the exact contract. Central
   service tests and gateway tests fail red against missing token binding,
   proof validation, replay state, key generation, credential version 2,
   transport headers, nonce handling, and tool-argument removal.
3. Central implements proof validation, token binding, nonce challenges,
   replay protection, DPoP errors, same-key reissue, email-control recovery,
   revocation, and transport authentication behind a disabled enforcement
   flag.
4. Central enables DPoP issuance and protected-resource validation in a
   development environment while retaining explicitly tagged legacy bearer
   tokens.
5. The gateway implements DPoP enrollment and protected REST and MCP transport
   without opportunistic bearer fallback.
6. Existing identities migrate through email-control re-verification.
7. Central requires DPoP for every new and migrated token, then removes legacy
   bearer support after the reviewed migration deadline.

The gateway must not ship production DPoP mode before the issuer and every
resource endpoint enforce it. Proof generation by itself is not a security
milestone.

## Accepted choices and production confirmations

The user accepted these base decisions on 2026-08-29 so red tests and central
API implementation have one target:

- `ES256` with P-256 and no algorithm negotiation;
- exact public JWK and proof schemas with lowercase UUID v4 proof IDs;
- a 60-second maximum proof age and 5 seconds of future clock skew;
- mandatory 57-byte stateless authenticated server nonces, encoded as 76
  base64url characters, with a five-minute acceptance window;
- shared atomic replay rejection with 65-second retention, 256 live entries per
  proof key and security domain, and 1,000,000 per security domain;
- a 4 KiB token limit, 4 KiB proof limit, 4,101-byte complete authorization
  value, 8,197-byte combined credential-field-value limit, and 16 KiB total
  request-header limit;
- 24-hour JWTs, same-key reissue at 12 hours remaining, and a 48-hour reissue
  idempotency record, with at most three active same-key tokens, four new
  reissue keys per day, and eight retained reissue results per identity;
- unversioned bootstrap routes, protected REST routes under `/api/v2`, token
  lifecycle at `/api/v2/token/reissue` and `/api/v2/token/revoke`, and one
  stable MCP transport at `/mcp`;
- the strict version 2 encrypted credential record in this ADR;
- email-control re-verification for key rotation, key loss, recovery, and
  legacy bearer migration; and
- no bearer fallback for a DPoP-bound token.

The central owner must supply or confirm these deployment facts before
production activation:

1. canonical external HTTPS issuer, API resource, MCP resource, bootstrap API
   origin, version 2 API origin, and `/mcp` endpoint identifiers;
2. the production JWT signing and verification setup and confirmation that
   current authorization claims fit the 4 KiB token limit;
3. the shared atomic mechanism and reviewed capacity used for replay claims,
   revocation, recovery rate records, active-token counts, and reissue
   idempotency across all replicas;
4. the managed nonce-MAC key distribution, 24-hour rotation, previous-key
   retention, and replica clock monitoring;
5. the trusted reverse-proxy peers, ingress flood limits, and exact external URI
   reconstruction;
6. the database transaction that consumes a recovery code, revokes previous
   tokens, and issues the replacement;
7. the local user-authorized reset interface needed when an encrypted
   credential is unreadable or revocation has an uncertain outcome;
8. the development enforcement date, migration deadline, and legacy bearer
   removal date; and
9. whether central accepts this custom MCP DPoP profile or instead moves to a
   standards-compliant OAuth and MCP authorization design.

Production activation remains blocked until those facts and the D01 canonical
URLs are supplied. Tests may use `docs/v2-fixture-profile.md` while those facts
remain open. A central deployment choice must not weaken the fixed
client-visible contract without returning this ADR for review.

## Test requirements

Tests and CI precede production behavior. At minimum, both central fixtures and
the gateway suite must cover:

- correct issuance and protected proofs with independently computed
  signatures, thumbprints, and `ath` values;
- URI normalization vectors for host and scheme case, default ports, percent
  encodings, dot segments, empty paths, queries, consecutive slashes, path
  case, and trailing slashes;
- wrong method, URI, origin, algorithm, signature, public key, thumbprint,
  token hash, time, nonce, audience, issuer, token `jti`, expiry, revocation,
  and authorization scheme;
- missing, duplicate, oversized, or malformed authorization headers;
- exact acceptance and rejection boundaries for a 4,096-byte token,
  4,101-byte complete authorization value, 4,096-byte proof, 8,197-byte
  combined credential field values, and 16 KiB total request headers;
- unknown or duplicate JOSE members and proof claims, private JWK members,
  non-UUID proof IDs, noninteger timestamps, and invalid base64url values;
- proof replay on one process and across two server replicas;
- 60-second proof age, 5-second future skew, 65-second replay retention, and
  their boundary values;
- exact stateless nonce encoding, scope and key binding, current and previous
  MAC keys, concurrent nonce replacement, five-minute expiry, future skew, and
  one safe retry with a new `jti`;
- a flood of missing, invalid, and wrong-key nonces creating no nonce or replay
  records, plus fixed rejection when replay capacity reaches 256 per key or
  1,000,000 per security domain;
- no retry after timeout or after a second or malformed challenge;
- no verification-code consumption or MCP dispatch before DPoP validation;
- one fresh proof for every POST, GET, DELETE, and reconnect request;
- removal of `token` from upstream MCP schemas and arguments;
- atomic persistence and restart loading of the token and private key, with
  crash points before and after POSIX replacement publication; Windows
  replacement remains a future ADR 0033 qualification item;
- rejection of reissue when `iss`, `sub`, ordered `aud`, `cnf.jkt`, DPoP
  algorithm, token-signing algorithm, endpoint pair, or 24-hour lifetime
  changes;
- 24-hour issuance, same-key reissue with idempotency, old-token overlap,
  reissue persistence failure, and expiry while central is unavailable;
- no reissue, refresh, key rotation, credential replacement, or bearer fallback
  after a 401, invalid token, invalid proof, or ordinary operation failure;
- parallel and restart-driven reissue floods enforcing four new keys per day,
  eight retained results, and three active same-key tokens without evicting a
  live result or token;
- version 1 migration, key loss, key mismatch, email-control rotation,
  revocation, lost recovery response, and recovery persistence failure;
- recovery-code and attempt floods enforcing one live code and the fixed hourly
  rates without storing plaintext email or revealing identity existence;
- rejection of `Bearer` with a DPoP-bound token;
- rejection of a DPoP issuance response that lacks the expected binding;
- exact unversioned bootstrap paths, exact version 2 REST paths, `/mcp` for all
  central MCP traffic, and no probe or fallback to another route;
- `recipient_unavailable` for every recipient anti-enumeration case,
  `message_not_found` for an absent or foreign object, and 403 only for broad
  authorization after successful DPoP authentication;
- direct and trusted-proxy requests producing the same normalized `htu`; and
- artifact and transcript scans proving verification and reissue use identical
  token interception and redaction for tokens, private keys, proofs, nonces,
  and reissue idempotency keys.

Use fixed test keys and clocks only in fixtures. Production keys and `jti`
values must come from the operating system cryptographic random source.

## Compatibility and dependency impact

The gateway's public CLI and local webhook authentication do not change. DPoP
applies only from the gateway to the central service. Provider connectors do
not receive or use the central token or DPoP key.

This change affects REST enrollment, REST polling, authenticated central MCP,
the local tool projection, encrypted credential storage, fake central
services, and central deployment. It must be coordinated with ADRs 0023 and
0025. It adds no approved dependency.

## Alternatives

- Send DPoP proofs while central still accepts bearer tokens. A stolen token
  remains usable without the key, so this does not meet the objective.
- Put the proof in MCP tool arguments. This does not bind the HTTP request and
  lets application dispatch happen before transport authentication.
- Use mutual TLS. It can provide sender-constrained tokens but adds certificate
  issuance, storage, proxy, and rotation requirements that are not part of the
  current service.
- Keep bearer JWTs and rely only on short expiry. This reduces exposure time
  but does not bind a token to the gateway and still needs reissue behavior.
- Move immediately to a full OAuth authorization server. That may be a sound
  later migration, but it is materially larger than protecting the current
  email-verification flow.

## References

- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449)
- [RFC 7638: JSON Web Key Thumbprint](https://www.rfc-editor.org/rfc/rfc7638)
- [RFC 3986: Uniform Resource Identifier](https://www.rfc-editor.org/rfc/rfc3986)
- [RFC 9562: Universally Unique Identifiers](https://www.rfc-editor.org/rfc/rfc9562)
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## Approval

The user approved this DPoP contract together with ADRs 0023 and 0025 on
2026-08-29. The approval freezes the gateway and fixture contract. Central must
implement issuer and resource-server enforcement before production activation.
The local identity-reset interface remains blocked on a separate user decision.
