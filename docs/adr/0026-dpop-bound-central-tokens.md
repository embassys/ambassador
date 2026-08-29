# 0026 DPoP-bound central tokens

Status: proposed

Date: 2026-08-29

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
key, sign request bodies, or protect against theft of both the encrypted
credential and its local decryption secret. The existing credential storage,
endpoint binding, local MCP authentication, input validation, and data boundary
remain necessary.

## Proposed decision

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
- the `DPoP` authorization scheme for every protected central request; and
- nonce challenge support at token issuance and protected resources.

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

The header contains no private `d` value and no symmetric key. The gateway
does not use `kid` instead of the public JWK.

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

`htu` is the externally visible absolute target URI without query or fragment.
For example, a poll of
`https://central.example/api/poll_messages?timeout=30` signs
`https://central.example/api/poll_messages`. `htm` is the actual uppercase HTTP
method. Every retry creates a new proof with a new `jti` and current `iat`.

## Required server interface

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

The successful response extends the proposed REST enrollment response:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "token": "<central-jwt>",
  "token_type": "DPoP",
  "message": "Email verified"
}
```

The JWT payload must contain:

```json
{
  "cnf": {
    "jkt": "<base64url-rfc7638-sha256-thumbprint>"
  }
}
```

The server must define and validate the JWT's existing issuer, audience,
subject, expiry, and authorization claims. `token_type` is required and must be
`DPoP`. The gateway rejects and does not persist a verification response with a
missing or different token type, a malformed JWT, a missing `cnf.jkt`, or a
thumbprint that differs from its generated public key.

Successful and failed verification responses must include a
`Cache-Control: no-store` header. The central service, reverse proxy, and
observability pipeline must not cache or log verification bodies,
authorization headers, proofs, nonces, or JWT claims.

Registration and verification resend remain bootstrap operations without a
central access token. They do not carry an `Authorization` header. They also do
not need a DPoP proof because they neither issue nor consume a protected token.

### Protected REST requests

Every central REST route that currently accepts the JWT as bearer
authentication must instead accept this pair:

```http
GET /api/poll_messages?timeout=30 HTTP/1.1
Host: central.example
Authorization: DPoP <central-jwt>
DPoP: <protected-resource-proof>
```

The proof uses `htm` `GET`, the poll URL without its query, and an `ath` value
calculated as base64url without padding of SHA-256 over the ASCII JWT value.
Reply, action, permission, acknowledgement, and recovery routes use the same
headers with their own method and target URI.

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

This transport profile is an explicit extension of the project's current
custom central authentication. If the central MCP service later adopts the MCP
OAuth authorization profile, that migration requires its own discovery,
audience, client, and token-endpoint decision.

### Nonce challenges

The server may require a fresh server nonce. The token-issuance response is:

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

The server returns exactly one bounded, unpredictable `DPoP-Nonce` value. It
must reject the request before consuming a verification code, dispatching an
MCP method, or performing any other application side effect.

The gateway keeps nonces only in bounded process memory, scoped separately to
the token issuer and protected-resource origin. On one valid nonce challenge it
may repeat the request once with the supplied nonce, a new proof, and a new
`jti`. A second challenge, malformed challenge, timeout, connection loss, or
ordinary authentication failure is not retried automatically. This is
especially important for verification and side-effecting MCP tool calls.

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

The gateway maps these results to fixed local errors. It never reflects the
remote proof, nonce, token, response body, header values, or URL.

## Server validation and state requirements

The token issuer must:

1. require one issuance proof on verification;
2. verify the JOSE header, signature, claims, method, target URI, time, and
   nonce when required;
3. compute the public-key thumbprint using RFC 7638 canonical EC members in
   `crv`, `kty`, `x`, `y` order;
4. place that thumbprint in the signed JWT's `cnf.jkt` claim;
5. return `token_type` `DPoP`; and
6. never issue or return the token if proof validation fails.

Every resource server, including the MCP HTTP endpoint, must:

1. validate the central JWT by its normal signature and authorization rules;
2. require the `DPoP` authorization scheme for a token with `cnf.jkt`;
3. validate the proof and match its key to `cnf.jkt`;
4. validate `ath`, `htm`, `htu`, `iat`, and nonce when required;
5. atomically reject replayed proofs inside the acceptance window; and
6. complete those checks before parsing or dispatching an application body.

Replay state must work across all replicas that can receive a request. A
process-local cache behind a load balancer does not provide the required
guarantee unless routing pins every token or key to one replica for the full
proof lifetime. The replay key should use a bounded hash of the public-key
thumbprint and `jti`, not an attacker-sized raw value.

A reverse proxy must reconstruct the external HTTPS URI used by the gateway.
It may trust forwarded scheme and host values only from an explicitly trusted
proxy. Internal HTTP routing, untrusted `Forwarded` headers, default-port
normalization, or a query string must not cause the client and server to
calculate different `htu` values.

The proposed first limits are a 60-second proof lifetime, 5 seconds of allowed
future clock skew, UUID v4 `jti` values, a 512-byte nonce limit, and an 8 KiB
combined authorization-header limit. These values are not approved. The
central and gateway owners must select the same fixed limits before tests.

## Gateway key and credential lifecycle

The gateway generates one P-256 key pair in memory immediately before a
verification attempt. It sends only the public key in the DPoP proof. After a
successful response, it validates `token_type` and `cnf.jkt`, then persists the
JWT, token type, algorithm, and private key as one atomic encrypted credential.
Only after that transaction succeeds may it enable authenticated tools or
polling.

ADR 0019's encrypted credential needs a version 2 plaintext record inside the
existing AES-256-GCM envelope. The proposed record contains only:

```json
{
  "credential_version": 2,
  "token_type": "DPoP",
  "access_token": "<central-jwt>",
  "dpop_alg": "ES256",
  "dpop_private_key_pkcs8": "<base64url-pkcs8-der>"
}
```

The outer file continues to expose only cryptographic metadata and ciphertext.
The endpoint pair remains additional authenticated data. The file contains no
email, username, public identity, nonce, proof, message, or provider state.
Private-key bytes, plaintext records, tokens, proofs, and nonces must not enter
logs, SQLite, diagnostics, metrics, temporary files, crash artifacts, or
support bundles.

This record format and its migration supersede the JWT-only payload portion of
ADR 0019 if approved. Its existing KDF, encryption, filesystem, endpoint
binding, and atomic durability rules remain unchanged. OS credential-vault
storage remains a separate future improvement.

If approved, this record also supersedes ADR 0019's permitted transient token
locations. A DPoP-bound JWT may appear only in the `Authorization: DPoP` header
of a gateway-to-central REST or MCP request, and transiently while calculating
`ath`. It must no longer appear in an MCP tool argument. Protocol v1 and ADR
0017 require the same narrow amendment after implementation.

## Migration and recovery

An existing bearer JWT cannot be converted into a DPoP-bound token by the
gateway. The issuer must sign a new token containing the new key thumbprint.
The central service must provide one of these reviewed migration paths:

- require email re-verification and issue a new DPoP-bound token; or
- add an authenticated, one-time reissue operation that accepts a new issuance
  proof, atomically issues a DPoP-bound token, and revokes the old bearer token.

A reissue route authorized only by the old bearer token lets anyone holding a
stolen bearer token bind the replacement to their own key. If central chooses
that design, it must add an independent user-verification factor or document
and accept the takeover risk. The endpoint name, request schema, revocation
transaction, and lost-response recovery behavior remain central contract
gates.

Key loss needs the same re-verification or recovery path. Key rotation must
issue a new token bound to the new key and revoke the old token atomically. The
gateway must never fall back from a DPoP token to bearer authentication after a
proof failure.

Legacy credential version 1 may remain readable only during an explicit,
time-limited server migration phase. It cannot be upgraded locally. The final
rollout must define when the gateway rejects version 1 and when central stops
accepting legacy bearer tokens.

## Rollout order

1. The contract, limits, storage record, and migration are approved.
2. Both independent central fixtures implement the exact contract. Central
   service tests and gateway tests fail red against missing token binding,
   proof validation, replay state, key generation, credential version 2,
   transport headers, nonce handling, and tool-argument removal.
3. Central implements proof validation, token binding, nonce challenges,
   replay protection, DPoP errors, and transport authentication behind a
   disabled enforcement flag.
4. Central enables DPoP issuance and protected-resource validation in a
   development environment while retaining explicitly tagged legacy bearer
   tokens.
5. The gateway implements DPoP enrollment and protected REST and MCP transport
   without opportunistic bearer fallback.
6. Existing identities migrate through the approved reissue or re-verification
   path.
7. Central requires DPoP for every new and migrated token, then removes legacy
   bearer support on the approved date.

The gateway must not ship production DPoP mode before the issuer and every
resource endpoint enforce it. Proof generation by itself is not a security
milestone.

## Contract gates

Implementation remains blocked until the user and central service owner
approve:

1. the `ES256` and P-256 algorithm profile;
2. the exact verification response, including required `token_type` and JWT
   `cnf.jkt`;
3. the canonical external verification, REST, and MCP URLs used for `htu`;
4. proof, clock-skew, nonce, header, and replay limits;
5. cross-replica replay and nonce state behavior;
6. the complete error and challenge contract;
7. removal of token fields from central MCP schemas;
8. the credential version 2 plaintext serialization;
9. token expiry, revocation, reissue, key rotation, and lost-response recovery;
10. the legacy bearer migration and removal schedule; and
11. whether the custom issuance profile will remain service-specific or move
    to a standards-compliant OAuth token endpoint and metadata document.

## Test requirements

Tests and CI precede production behavior. At minimum, both central fixtures and
the gateway suite must cover:

- correct issuance and protected proofs with independently computed
  signatures, thumbprints, and `ath` values;
- wrong method, URI, query handling, origin, algorithm, signature, public key,
  thumbprint, token hash, time, nonce, and authorization scheme;
- missing, duplicate, oversized, or malformed authorization headers;
- proof replay on one process and across two server replicas;
- nonce challenge and one safe retry with a new `jti`;
- no retry after timeout or after a second or malformed challenge;
- no verification-code consumption or MCP dispatch before DPoP validation;
- one fresh proof for every POST, GET, DELETE, and reconnect request;
- removal of `token` from upstream MCP schemas and arguments;
- atomic persistence and restart loading of the token and private key;
- version 1 migration, key loss, key mismatch, rotation, and revocation;
- rejection of `Bearer` with a DPoP-bound token;
- rejection of a DPoP issuance response that lacks the expected binding; and
- artifact and transcript scans for tokens, private keys, proofs, and nonces.

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
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## Approval

Not approved. The user requested a DPoP implementation plan and the required
central server interface on 2026-08-29. No production gateway or server work is
authorized by this record.
