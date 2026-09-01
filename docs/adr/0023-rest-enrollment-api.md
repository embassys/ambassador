# 0023 REST enrollment API

Status: superseded by ADR 0037

Date: 2026-08-29

Approved: 2026-08-29

ADR 0037 replaces the proposed `/api/register` and issuance-proof contract
with the deployed `/api/register_agent` and verification-body JWK contract.

Migration and in-place-upgrade requirements are superseded by accepted ADR
0027. The future gateway is fresh-install-only.

## Problem

The accepted gateway forwards `register_agent`, `verify_email`, and
`resend_verification` to the central MCP server. The user has now supplied a
REST flow for registration, verification, and polling. Keeping bootstrap work
on MCP would couple credential issuance to an older contract and to the
temporary Python-literal result parser.

The supplied example uses `POST /api/register`. A read-only OpenAPI snapshot
checked on 2026-08-29 advertised `POST /api/register_agent` instead. This
decision gives the newer, explicit user contract precedence and selects
`/api/register`. The gateway must not probe, fall back to the older path, or
fall back to MCP when the selected route returns `404`.

The example also uses plain HTTP on a non-loopback IP address. That would expose
the registration email, verification code, and issued token in transit. The
address is evidence for the paths and request shapes only. It is not an
approved product endpoint.

## Evidence and precedence

The newest supplied flow is:

```text
POST /api/register
{"email":"test@example.com","username":"test_agent"}

POST /api/verify_email
{"email":"test@example.com","code":"123456"}

GET /api/poll_messages?timeout=30
Authorization: Bearer <issued-token>
```

The earlier OpenAPI snapshot described these additional facts:

- registration accepts an optional `display_name`;
- registration returns `agent_id`, `username`, and `email`, with an optional
  `message`;
- verification returns `agent_id`, `username`, and `token`, with an optional
  `message`;
- resend uses `POST /api/resend_verification` with `email`;
- registration usernames contain 3 to 50 characters;
- verification codes contain six characters, but the schema did not restrict
  them to decimal digits;
- registration is described as limited to three requests per email per hour;
- resend is described as limited to five requests per email per hour; and
- the document lists `200` and validation `422`, but not the complete error
  contract.

Where those observations conflict with the newer supplied flow, the supplied
flow wins. Where the supplied flow is silent, this ADR uses the observed shape
as a compatibility input and records the remaining server facts for review.

## Decision

Keep the local MCP bootstrap tool names and replace their central MCP dispatch
with a project-owned REST client. The client uses fixed product paths under one
approved central API base URL:

| Local MCP tool | Central request | Authentication |
| --- | --- | --- |
| `register_agent` | `POST /api/register` | No central access token |
| `verify_email` | `POST /api/verify_email` | No central access token. ADR 0026 requires an issuance proof |
| `resend_verification` | `POST /api/resend_verification` | No central access token |

The route set is intentionally unversioned because that matches the supplied
contract. A future incompatible server contract must use a reviewed new path
and a coordinated gateway release. The gateway does not perform runtime
version or capability discovery.

The authenticated central MCP tools remain on MCP. Notification polling stays
on the existing REST path and retains its current temporary `404`-only MCP
fallback until a separate approved cleanup removes it.

## Local MCP contract

The gateway owns the bootstrap tool definitions. It can list them while the
central MCP service is unavailable. Every schema has
`additionalProperties: false`.

The available bootstrap tools depend on one local identity state:

| State | Bootstrap catalog | Rule |
| --- | --- | --- |
| `unenrolled` | `register_agent`, `verify_email`, `resend_verification` | May create the first local identity |
| `migration_required` | `verify_email`, `resend_verification` | A readable version 1 credential is never sent; email-control recovery may replace only that identity |
| `recovery_authorized` | `verify_email`, `resend_verification` | An explicit local user action has authorized recovery of the current identity |
| `enrolled` | None | Ordinary enrollment cannot replace the identity |

The gateway never enters `recovery_authorized` merely because authentication,
proof use, key import, or decryption fails. The local user-authorized recovery
and reset interface is still open for review. Until that interface is approved,
an enrolled or unreadable credential cannot be replaced through these tools.

### `register_agent`

Required input:

```json
{
  "email": "test@example.com",
  "username": "test_agent"
}
```

Optional `display_name` may be present. The gateway rejects `null`, empty
values, leading or trailing whitespace, ASCII control characters, and unknown
properties. It applies these bounds before serialization:

| Field | Bound |
| --- | --- |
| `email` | 3 to 254 characters and at most 254 UTF-8 bytes; must match `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `username` | 3 to 50 characters and at most 200 UTF-8 bytes |
| `display_name` | 1 to 128 characters and at most 512 UTF-8 bytes |

The gateway does not lowercase, trim, or otherwise rewrite these values. It
sends exactly `email` and `username`, plus `display_name` only when the caller
supplied it.

The token-free local success result is:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "email": "test@example.com",
  "message": "Verification code sent."
}
```

### `verify_email`

The exact input contains `email` and `code`:

```json
{
  "email": "test@example.com",
  "code": "123456"
}
```

`email` follows the registration bound. `code` contains exactly six ASCII
alphanumeric characters. The gateway preserves its case. It redacts every
value under a `code`, `verification_code`, or `recovery_code` key, even when
the value does not match this schema.

In `unenrolled`, verification may complete the pending registration. In
`migration_required` or `recovery_authorized`, the code must be a fresh
email-control recovery code for the intended existing identity. The gateway
rejects verification in normal `enrolled` state before generating a key or
sending a central request.

The token-free local success result remains:

```json
{
  "verified": true,
  "agent_id": "agent_123",
  "username": "test_agent",
  "message": "Email verified successfully."
}
```

### `resend_verification`

The exact input contains only `email`:

```json
{
  "email": "test@example.com"
}
```

The token-free local success result is:

```json
{
  "message": "Verification code resent."
}
```

The central service returns the same success response for a pending
registration, a verified identity, and an unknown syntactically valid email.
For a pending registration it sends a new enrollment code. For a verified
identity it sends a new single-use email-control recovery code. It sends
nothing for an unknown email. This prevents the route from revealing whether
an identity exists. The gateway exposes resend for a verified identity only in
`migration_required` or `recovery_authorized`.

## HTTP request contract

Each operation sends one HTTP request with:

```text
Accept: application/json
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

The body is one UTF-8 JSON object with only the projected fields. The gateway
does not send cookies, a central bearer token, a local webhook token, or user
supplied headers. It rejects redirects and never follows an upstream-provided
URL.

Each verification attempt generates one P-256 key and
sends `DPoP: <issuance-proof>`. The request has no `Authorization` header and
the proof has no `ath`. Registration and resend carry neither `Authorization`
nor `DPoP`. One valid nonce challenge reuses the verification attempt's key but
uses a fresh proof, `jti`, `iat`, and the challenged nonce.

Remote central URLs require HTTPS. Plain HTTP is valid only when the central
host is exactly `127.0.0.1`, `[::1]`, or `localhost` for a test fixture. The
canonical API base is a product constant, not a CLI option or general
configuration value. Its hostname remains unresolved and this ADR does not
invent one.

Each bootstrap operation has a fixed 30-second total deadline, including
connection establishment, response headers, and body reading. Caller
cancellation and the internal deadline are combined. Production does not make
the deadline configurable.

## Successful central responses

All three routes return `200`. The response must have `Content-Type:
application/json`; the only permitted media-type parameter is an optional
UTF-8 `charset`. The response must not use content encoding. A missing or
different media type, another success status such as `201` or `204`, or a
redirect is a contract failure.

Registration requires this shape:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "email": "test@example.com",
  "message": "Verification code sent."
}
```

`message` is optional on the wire. Verification requires:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "token": "central-jwt",
  "message": "Email verified successfully."
}
```

`message` is optional on the wire. Verification requires every credential
field in this projection and exactly one top-level `token`; `message` remains
optional:

```json
{
  "agent_id": "agent_123",
  "username": "test_agent",
  "token": "central-jwt",
  "token_type": "DPoP",
  "expires_in": 86400,
  "message": "Email verified successfully."
}
```

The gateway requires `token_type` to equal `DPoP`, `expires_in` to equal
`86400`, the decoded JWT lifetime to match, and the JWT `cnf.jkt` to equal the
thumbprint of the verification attempt's key. It validates every invariant in
ADR 0026 before persistence. A failed validation exposes no credential and
leaves any prior record unchanged.

Resend returns an object with an optional `message`:

```json
{
  "message": "Verification code resent."
}
```

The gateway returns the remote `message` only when it is a nonempty string no
larger than 1,024 UTF-8 bytes. Otherwise it uses the fixed local message shown
for that operation. It never reflects remote prose from an error response.

The known success fields have these bounds:

| Field | Bound |
| --- | --- |
| `agent_id` | 1 to 128 URI-unreserved ASCII characters |
| `username` | Same bounds as the request |
| `email` | Same bounds as the request |
| `token` | 1 to 4,096 ASCII bytes with no whitespace or control characters |
| `token_type` | Exact string `DPoP` |
| `expires_in` | Exact integer `86400` |
| `message` | 1 to 1,024 UTF-8 bytes |

The gateway accepts a success extension only after recursively checking the
complete response. Credential names are compared case-insensitively.
Registration and resend reject `token`, `jwt`, `access_token`, `authorization`,
`private_key`, `dpop_proof`, and `nonce` at any depth. Verification permits
`token` only once at the top level and rejects every other listed name at any
depth. Every accepted extension is discarded. The gateway also rejects any
non-token value that contains the issued token bytes. ADR 0026 defines the
exact allowed DPoP response fields.

Central must send `Cache-Control: no-store` on every verification response,
including errors and nonce challenges. A successful verification response
should also send `Pragma: no-cache` for older intermediaries. The gateway maps
any verification response without an exact `no-store` directive to
`central_verification_response_unsafe`. It does not retry, map the remote body,
or persist a credential from that response.

## Error contract

The server application-error body is one exact object with no remote prose:

```json
{
  "error": {
    "code": "verification_failed"
  }
}
```

The server uses these statuses and codes:

| Route | Status | Code | Required behavior |
| --- | --- | --- | --- |
| Any bootstrap route | `422` | `invalid_request` | Reject before changing state or sending email |
| Register | `409` | `registration_conflict` | Do not say whether the email or username conflicted |
| Verify | `400` | `verification_failed` | Use for an unknown email and an invalid, expired, consumed, or superseded code |
| Any bootstrap route | `429` | `rate_limited` | Reject before changing state and include an integer delta-seconds `Retry-After` header |
| Any bootstrap route | `500` | `internal_error` | Do not include request data in the body |
| Any bootstrap route | `503` | `temporarily_unavailable` | Do not include request data in the body |

ADR 0026's flat `{"error":"use_dpop_nonce"}` and
`{"error":"invalid_dpop_proof"}` verification errors augment this table. A
valid nonce challenge has all of these properties:

- HTTP status `400`;
- `Content-Type: application/json`;
- `Cache-Control` containing `no-store`;
- the exact `{"error":"use_dpop_nonce"}` body;
- exactly one `DPoP-Nonce` header; and
- a nonce containing exactly 76 unpadded base64url characters.

The gateway handles the first valid challenge internally and never exposes its
body. It repeats verification once with the same attempt key and a fresh proof,
`jti`, and `iat`. A second challenge, duplicate or missing nonce header,
malformed nonce, wrong body, wrong status, wrong media type, or missing
`no-store` does not trigger a retry. No other DPoP error shape is accepted
without another contract review.

Registration returns `409` for an existing pending or verified email, an
existing username, or an explicit repeat of the same registration. A caller
recovering from a lost registration response uses `resend_verification`, then
continues with email verification. The conflict response reveals no matching
field and returns no agent ID.

For a syntactically valid resend request, central returns `200` whether or not
the email exists. For a pending registration or verified identity, resend
atomically replaces the older code for the same purpose before sending the new
code. Enrollment and recovery codes remain purpose-bound and single-use. Only
the newest code for that purpose remains valid.

After successful verification, central consumes the code and never returns the
issued token for the same code again. Repeated verification returns the generic
`verification_failed` response. The gateway cannot solve a lost verification
response by retrying that code. The user requests a new
recovery code and repeats email-control verification with a new key. Central
revokes the token from the lost response when the later recovery transaction
succeeds.

The gateway maps only the reviewed status and code pairs. It returns fixed
local error identifiers:

| Central outcome | Local error |
| --- | --- |
| Register `409 registration_conflict` | `registration_conflict` |
| Verify `400 verification_failed` | `verification_failed` |
| First well-formed `use_dpop_nonce` challenge | Internal retry, no local error |
| Well-formed second nonce challenge | `central_dpop_nonce_retry_exhausted` |
| Malformed nonce challenge or malformed or duplicate `DPoP-Nonce` header | `central_dpop_challenge_failed` |
| `400 invalid_dpop_proof` with required safe headers | `central_dpop_proof_rejected` |
| Any verification response missing `Cache-Control: no-store` | `central_verification_response_unsafe` |
| DPoP verification success with a missing or invalid token type, lifetime, or key binding | `central_verification_credential_invalid` |
| Reviewed `429 rate_limited` | `central_rate_limited` |
| Reviewed `422 invalid_request` after local validation | `central_enrollment_contract_failed` |
| `500`, `503`, timeout after dispatch, cancellation after dispatch, connection loss, or redirect | `central_enrollment_outcome_uncertain` |
| Any other status, code, media type, malformed body, or invalid success body | `central_enrollment_contract_failed` |

The missing-`no-store` mapping takes precedence over a response-body mapping.
For example, an otherwise valid `invalid_dpop_proof` response without
`no-store` becomes `central_verification_response_unsafe`. A malformed or
duplicate `DPoP-Nonce` on a successful response also becomes
`central_dpop_challenge_failed`, and the gateway persists nothing.

Local errors contain no URL, headers, request fields, response fields, remote
message, email, code, token, or body excerpt. A failure before any application
bytes can reach central may use `central_enrollment_unavailable`, but the client
does not rely on that distinction for retry.

## Retry and uncertainty

The gateway sends at most one initial request for each local bootstrap call.
It does not retry a connection error, timeout, cancellation, redirect, `429`,
or `5xx` response. It does not retry on a second route and does not fall back
to central MCP.

An explicit user call may retry registration or resend. Central's conflict and
generic resend behavior make those cases recoverable. The gateway and user do
not repeat a verification code after an uncertain outcome because the first
call may have consumed it and issued a token. They may request a fresh recovery
code and begin a new verification attempt with a new key.

One server nonce challenge is the only automatic
exception. The gateway may retry verification once with the supplied nonce and
a fresh proof because central must validate the proof before consuming the
code. A transport timeout or any other uncertain outcome still receives no
automatic retry.

## Parsing and resource limits

The REST client applies the following fixed limits to every bootstrap response,
including errors:

| Resource | Limit |
| --- | --- |
| Response headers | 16 KiB |
| Response body | 64 KiB of received bytes |
| JSON nesting | 16 container levels |
| JSON structural tokens | 1,024 |
| Object members | 128 across the complete value |
| Array elements | 128 across the complete value |

The client rejects an oversized header or body while reading. Before
`JSON.parse`, it validates UTF-8, depth, structural count, trailing data, and
duplicate object keys. The top-level value must be an object. A rejected
response does not change identity state, start polling, or emit a tool-list
notification.

The request field bounds keep each generated request well below 2 KiB. The
client still checks its serialized request before opening the connection and
rejects any body larger than 2 KiB as an internal contract error.

## Identity transaction

Verification follows this custody order:

1. Permit it only in `unenrolled`, `migration_required`, or an explicitly
   entered `recovery_authorized` state. Reject it in normal `enrolled` state
   before generating a key or sending a central request.
2. Serialize concurrent verification attempts.
3. Generate one new P-256 key for this attempt and use it
   for the initial proof and one permitted nonce retry.
4. Validate the complete bounded response and required safety headers.
5. Extract the top-level token before any local result or transcript is built.
6. Validate the DPoP token type, lifetime, subject, and public-key binding.
7. For migration or recovery, require the new JWT's byte-exact `iss` and `sub`
   strings and exact ordered `aud` array to match the readable prior token.
   Also validate the returned `agent_id` against the intended identity under
   the confirmed central response contract. Any mismatch rejects the response
   and leaves the prior record unchanged.
8. Create the first credential, or atomically replace the complete prior
   credential only in an authorized migration or recovery state.
9. Enable authenticated tools and notification polling.
10. Emit `notifications/tools/list_changed`.
11. Return the exact token-free local result.

If persistence fails, verification does not report success. The gateway keeps
authenticated work disabled and exposes no token. In a recovery flow, the
server may already have revoked the prior token. The gateway keeps the old
encrypted record rather than publishing a partial replacement, requests a new
recovery code, and repeats the complete recovery transaction. It never resumes
use of a token that central may have revoked.

## Recovery and replacement

Normal DPoP same-key reissue and email-control recovery solve different cases.
`POST /api/v2/token/reissue` requires a still-valid DPoP token and its matching
private key. It renews that identity with the same key. It can recover a lost
reissue response or replacement persistence failure while the prior DPoP
credential remains usable.

Same-key reissue cannot recover any of these cases:

- the initial verification response was lost before a credential was stored;
- the DPoP private key is lost, corrupt, or does not match the token;
- a version 1 bearer credential needs migration;
- the encrypted record cannot be decrypted after the webhook token changes; or
- the current DPoP token has expired or been revoked.

Except for an unreadable record, those cases require a fresh code from generic
`resend_verification`, a new P-256 key, and email-control verification. Central
binds a recovery code to the existing identity, consumes it, revokes prior
tokens, and issues one token bound to the new key in one transaction. The
gateway accepts the response as a replacement only in `migration_required` or
`recovery_authorized`, and only when it can prove the returned identity matches
the intended current identity.

A readable version 1 record enters `migration_required` automatically and is
never sent as a bearer credential. An ordinary working identity does not enter
recovery automatically. A user must authorize that transition through the
future local recovery interface. If the prior record is unreadable and the
gateway cannot establish the intended identity, it must not overwrite the
file. Deleting or replacing that record requires the separate user-authorized
reset interface before a new recovery email may replace it. The form of that
interface, its confirmation steps, how it establishes the intended identity,
and its behavior after an uncertain revocation remain open for review.

## Polling compatibility

The supplied polling route matches protocol v1:

```text
GET /api/poll_messages?timeout=30
Authorization: Bearer <central-token>
```

This ADR assumes the existing behavior remains unchanged. A `200` response
contains exactly one `messages` array, including `{"messages":[]}` when the
long poll expires. Returning a message atomically changes it from queued to
delivered. The gateway retains the existing 40-second client deadline, 4 MiB
wire cap, pre-parse limits, 256-message bound, 512 KiB normalized-result bound,
in-memory body custody, and ID-only journal.

The current explicit `404` behavior remains a temporary compatibility switch
to MCP polling. No bootstrap route uses that switch. Once central confirms and
staging proves that `/api/poll_messages` is stable, a separate cleanup removes
the fallback.

Polling uses `Authorization: DPoP <token>` plus
a fresh `DPoP` proof. There is no bearer fallback for a DPoP-bound token.

## Security and data boundary

- Never write a bootstrap request or response, email, display name,
  enrollment code, recovery code, token, private key, proof, nonce, or other
  DPoP material to SQLite, configuration, normal logs, diagnostics, metrics,
  temporary files, crash artifacts, or support bundles.
- Before the temporary development transcript serializes any request,
  response, or error, redact fields named `code`, `verification_code`, or
  `recovery_code` case-insensitively. Also redact every occurrence of the known
  code bytes, even outside a named field or when the value is not decimal.
- Redact values of `Authorization`, `DPoP`, `DPoP-Nonce`,
  `WWW-Authenticate`, `Cookie`, `Set-Cookie`, and webhook-signature headers
  case-insensitively. Redact known token, private-key, proof, and nonce bytes
  before serializing a header or body. Header names may remain for diagnosis;
  their values may not.
- Do not place an email, code, token, or proof in a URL or query string.
- Do not send a bearer credential to registration, verification, or resend.
- Do not accept remote plain HTTP, redirects, compressed responses, cookies, or
  server-selected callback URLs.
- Bind the encrypted credential to the canonical central API and MCP endpoint
  pair. An endpoint change must not silently reuse an identity issued for a
  different service.
- Keep provider connectors outside this flow. The gateway remains the only
  component that receives and stores the central credential.

## DPoP dependency

ADR 0026 defines the verification request, successful response, stored
credential, polling authentication, and authenticated central MCP transport.
This REST work must ship with the DPoP issuer and resource-server
enforcement. It must not ship an intermediate mode that sends proofs while the
server still accepts the issued token as a bearer token.

The verification schema and protected polling headers are frozen jointly by
this ADR and ADR 0026.

## Accepted defaults and production confirmations

The following choices are accepted based on the supplied flow, the earlier
OpenAPI snapshot, and the accepted gateway safety rules. The fixture profile
in `docs/v2-fixture-profile.md` supplies deterministic test values where
production facts are not available.

| Item | Accepted contract | Production confirmation |
| --- | --- | --- |
| Registration route | `/api/register` only | Central owner must confirm deployment and retire or redirect `/api/register_agent` outside the gateway contract |
| Route versioning | Keep the supplied unversioned paths | Central owner must commit to compatibility or propose coordinated versioned paths |
| API and MCP bases | Fixed HTTPS product constants | Central owner must supply canonical hostnames and external URLs. This ADR does not invent them |
| Success status | `200` for all three bootstrap routes | Central owner must confirm before fixtures freeze |
| Verification code | Six ASCII alphanumeric characters | Central owner must confirm whether production is decimal-only or supports another alphabet |
| Registration response | Required `agent_id`, `username`, and `email`; optional `message` | Central owner must confirm the actual response |
| Verification response | Required `agent_id`, `username`, and one token; optional `message` | DPoP approval changes this contract and central must confirm token lifetime |
| Resend privacy | The same `200` for pending, verified, and unknown email; pending receives enrollment mail and verified receives recovery mail | Central owner must confirm that the route and rate limits do not reveal identity state |
| Repeated registration | Generic `409`; recovery proceeds through resend | Central owner must confirm that no partial duplicate record is created |
| Lost verification response | Never retry that code; request a fresh recovery code and verify with a new key | Central must revoke the token from a lost flow when the later recovery succeeds |
| Same-key reissue | Only renew a working DPoP token with its matching key | It cannot recover initial issuance, version 1, key loss, expiry, revocation, or an unreadable record |
| Recovery replacement | Permit only in `migration_required` or explicit `recovery_authorized`, and require the same central identity | Central owner must confirm the identity binding and atomic revoke-and-issue transaction |
| Local reset | Do not overwrite an unreadable or identity-mismatched record | User review must select the recovery and reset interface, confirmation steps, and uncertain-revocation behavior |
| Deadline | 30 seconds total per bootstrap call | Central owner must support the accepted client limit |
| Response limit | 16 KiB headers, 64 KiB body, 16 JSON levels | Central owner must support the accepted client limit |
| Rate limits | Observe `429` and `Retry-After`; never enforce or sleep in the gateway | Central owner must confirm registration, resend, and verification policies |
| Poll delivery | Full-message consuming long poll as documented in protocol v1 | Central owner must confirm before the MCP fallback can be removed |

Production activation stays blocked until central supplies the canonical HTTPS
endpoints and implements the accepted response, error, DPoP, recovery, and poll
contracts. The user-authorized local recovery and reset interface must also be
approved before an unreadable credential can be replaced. Tests may use the
fixture-only profile while those production facts remain open. Tests and
fixtures must land before the gateway implementation, as required by the active
implementation plan.

## Compatibility and migration

The public CLI and local MCP tool names do not change. Existing runtimes keep
the same bootstrap calls and never receive the central token.

The gateway does not keep `/api/register_agent` or central MCP bootstrap as a
runtime fallback. A fixture may test those old paths only to prove that the
gateway does not call them. This avoids a silent split in credential issuance
and error semantics.

Changing the canonical endpoint pair makes an existing encrypted credential
unreadable by design. Same-key reissue cannot help because the gateway cannot
load the credential needed to authenticate it. A deployment must migrate and
rewrite the credential while the old endpoint binding is still usable, or use
the future user-authorized reset and email-control recovery flow after its
local interface is approved.

An existing JWT-only credential cannot be upgraded by
the gateway. Central must issue a new key-bound token through the reviewed
email-control verification flow before the gateway writes credential version
2. Same-key reissue does not accept a version 1 bearer token.

When this ADR is implemented, ADR 0017 and protocol v1 need an
update because they currently describe bootstrap forwarding through central
MCP. ADR 0021 remains applicable to authenticated MCP results until a separate
cleanup removes the temporary parser.

## Required contract tests

- Assert the exact path, method, headers, field projection, and absence of
  credentials for each bootstrap request.
- Return `404` from `/api/register` and prove the gateway does not call
  `/api/register_agent` or central MCP.
- Run bootstrap tool listing and REST enrollment while central MCP is down.
- Exercise every reviewed status and code pair, malformed pair, redirect,
  media-type failure, duplicate key, invalid UTF-8, boundary, and one-over-limit
  case.
- Drop each response after the server processes its request. Prove no automatic
  retry and verify the documented recovery behavior.
- Exercise a valid first nonce challenge, malformed and duplicate nonce
  headers, a second challenge, invalid proof, missing `no-store`, invalid token
  type, invalid lifetime, and wrong `cnf.jkt`. Assert each fixed local mapping
  and prove that only the first valid challenge triggers one retry.
- Fail credential persistence after valid verification. Prove that polling and
  authenticated tools stay disabled and the local result contains no token.
- Lose the initial verification response, request a new recovery code, and
  prove that a later verification with a new key revokes the lost token. Never
  call same-key reissue in this path.
- Load a version 1 credential and prove that the gateway sends no bearer token,
  exposes only resend and verification, and atomically replaces it only with a
  matching version 2 identity.
- Enter explicit recovery for a readable version 2 identity and prove that a
  different returned identity, ordinary enrolled verification, and an
  unreadable record without reset authorization cannot replace the file.
- Restart after successful persistence and complete a poll and acknowledgement
  without another registration or verification request.
- Run the normal artifact scan and the separately approved verbose-transcript
  scan. Include code bytes outside named fields and every credential header.
  No email, code, token, private key, proof, nonce, request body, or response
  body may cross its allowed boundary.
- Run the same contract against the Node fixture and the independent Docker
  fixture before a staging smoke test uses a disposable central identity.

## Alternatives

- Keep bootstrap enrollment on central MCP. This avoids a client change but
  retains the older contract and temporary parser in the credential path.
- Probe `/api/register` and fall back to `/api/register_agent`. This can create
  different identities or send the same email twice after an uncertain result.
- Let the local agent call central REST directly. This exposes the issued token
  to the runtime and bypasses gateway credential custody.
- Move every central tool to REST in the same change. That expands the task
  beyond enrollment and the supplied poll compatibility contract.
- Permit remote plain HTTP for development. This exposes email, code, and token
  data and is rejected.

## Approval

The user approved this REST enrollment contract together with ADRs 0025 and
0026 on 2026-08-29. The approval freezes the gateway and fixture contract. It
does not invent production endpoints or confirm a central deployment. Central
must implement and publish those facts before production activation. The local
recovery and reset interface remains blocked on a separate user decision.
