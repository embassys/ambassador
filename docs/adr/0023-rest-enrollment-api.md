# 0023 REST enrollment API

Status: proposed

Date: 2026-08-29

## Problem

The accepted gateway forwards `register_agent`, `verify_email`, and
`resend_verification` to the central MCP server. The current central service now
advertises REST endpoints for those operations. Continuing to discover and call
bootstrap tools through central MCP would leave the gateway coupled to an older
contract and to the temporary MCP result-normalization path.

The supplied registration example uses `POST /api/register`. A read-only check
of the service's OpenAPI document on 2026-08-29 advertised
`POST /api/register_agent`. No implementation should choose between those paths
without a canonical answer from the central service owner.

The supplied service address uses plain HTTP on a non-loopback IP address. That
would expose the registration email, verification code, and issued JWT to the
network. It conflicts with the accepted rule that remote central endpoints use
HTTPS.

## Observed contract

The OpenAPI document advertised these request and success-response shapes:

| Operation | Request | Successful response |
| --- | --- | --- |
| Register | `POST /api/register_agent` with required `username` and `email`, plus optional `display_name` | Required `agent_id`, `username`, and `email`; optional `message` |
| Verify | `POST /api/verify_email` with required `email` and a six-character `code` | Required `agent_id`, `username`, and `token`; optional `message` |
| Resend | `POST /api/resend_verification` with required `email` | Optional `message` |
| Poll | `GET /api/poll_messages?timeout=<seconds>` with bearer authentication | Required `messages` array whose item schema is unspecified |

The registration username has a documented length of 3 to 50 characters. The
OpenAPI email pattern is part of the observed server contract. The verification
schema limits the code by length but does not say that every code is numeric.
Registration is described as limited to three requests per email per hour, and
resend is described as limited to five requests per email per hour.

The document specifies `200` and validation `422` responses. It does not define
the complete behavior for conflicts, invalid or expired codes, rate limits,
authentication failures, server errors, or a verification request whose token
was issued but whose response was lost.

## Proposed decision

Keep the local MCP interface and its bootstrap tool names. Replace central MCP
bootstrap forwarding with a project-owned central REST client:

1. The local gateway continues to expose `register_agent`, `verify_email`, and
   `resend_verification` before enrollment.
2. The gateway owns fixed local input schemas for those three tools. It no
   longer needs a central MCP connection or catalog request to list or call a
   bootstrap tool.
3. The REST client sends the reviewed JSON request to the canonical central API
   path. It accepts only the exact successful HTTP status and JSON media type,
   rejects redirects, applies caller cancellation and a fixed deadline, and
   bounds response bytes before parsing.
4. Registration, verification, and resend are not retried automatically. A
   timeout or connection loss after transmission returns a fixed
   uncertain-outcome error. Verification may already have issued the one-time
   JWT.
5. The verification parser rejects duplicate JSON keys, multiple credential
   fields, unexpected credential names, invalid UTF-8, excessive nesting, and
   trailing data. It requires nonempty `agent_id`, `username`, and `token`
   values. It accepts an optional nonempty `message` and rejects unsafe response
   extensions.
6. The identity layer persists the JWT before enabling authenticated tools or
   notification polling. The local result never contains the JWT. To preserve
   the current local contract when central omits `message`, the gateway returns
   a fixed gateway-owned success message instead of remote prose.
7. Registration and resend responses pass the existing recursive
   credential-leak checks before the gateway returns them locally.
8. Authenticated business tools continue to use central MCP in this change.
   Moving those tools to REST requires a separate decision.
9. Notification polling remains REST-first. This change does not remove the
   existing 404-only MCP polling fallback. Removing that compatibility path
   requires a separate decision after the REST route and its delivery semantics
   are stable.

ADR 0026 separately proposes making verification a DPoP token-issuance request
and moving authenticated REST and central MCP requests from bearer or tool
argument authentication to transport-level DPoP. If ADR 0026 is approved, its
verification headers, required `token_type`, JWT binding, credential
transaction, and protected-request rules become part of this contract. The
gateway must not implement an intermediate mode that sends DPoP proofs while
central still accepts the new token as a bearer token.

Use the existing Node HTTP and Web Crypto choices. Add no dependency. The final
deadline and bootstrap-response byte limit must be approved before production
work. A 30-second deadline and a 64 KiB response limit are the current proposal.

## Security requirements

- A remote central endpoint must use HTTPS. Plain HTTP remains valid only for a
  loopback test service.
- Do not add the supplied plain-HTTP IP address as a package constant or weaken
  endpoint validation to accept it.
- Never place the registration request, verification request, response body,
  email, code, or plaintext JWT in normal logs, SQLite, diagnostics, temporary
  files, crash artifacts, or support bundles.
- Redact every value under `code` or `verification_code` in the temporary
  development transcript. Do not limit redaction to six decimal digits.
- Redact the verification token before any transcript or error handling can
  serialize the response.
- Do not reflect remote error text, URLs, headers, or bodies in normal local MCP
  errors.
- Do not use bearer authentication for registration, verification, or resend
  unless the final central contract explicitly requires it.
- Continue to bind the encrypted credential to the canonical central API and
  MCP endpoint pair. An endpoint change must not silently reuse a credential
  issued for another service.

## Contract gates

Implementation remains blocked until the central service owner provides:

1. the canonical registration path, `/api/register` or
   `/api/register_agent`;
2. an HTTPS production or development endpoint;
3. exact success and error bodies and status codes for all three bootstrap
   operations;
4. the behavior of repeated registration, resend, repeated verification, and a
   verification response lost after token issuance;
5. the token format, lifetime, revocation, and reissue behavior;
6. confirmation that `poll_messages` still returns full messages with the
   consuming delivery semantics documented in protocol v1; and
7. acceptance or rejection of ADR 0026 before the verification response and
   authenticated polling contract are frozen.

## Compatibility and migration

The public CLI and local MCP tool names do not change. Existing local runtimes
should not need configuration changes.

The encrypted credential uses the canonical endpoint pair as authenticated
data. Changing either endpoint makes an existing credential unreadable by
design. The implementation agent must test with a new identity unless central
first provides token reissue or the endpoint pair remains byte-for-byte
canonical-equivalent.

If ADR 0026 is approved, existing JWT-only credential records cannot be
upgraded locally. Central must issue a new key-bound token through the reviewed
re-verification or reissue flow before the gateway writes credential version 2.

Once REST enrollment is accepted and shipped, ADR 0017 and protocol v1 need an
update because they currently say that bootstrap operations are forwarded to
central MCP. ADR 0021 remains applicable to authenticated MCP results until a
separate migration removes that compatibility parser.

## Alternatives

- Keep bootstrap enrollment on central MCP. This avoids a code change but does
  not use the new contract and retains the temporary parser in the credential
  issuance path.
- Let the local agent call central REST directly. This would expose the central
  JWT to the local runtime and bypass gateway credential custody.
- Move every central tool to REST in the same change. The service advertises
  those routes, but that would expand this task beyond the supplied enrollment
  and polling flow.
- Permit remote plain HTTP for development. This sends the email, code, and JWT
  without transport encryption and is rejected.

## Approval

Not approved. The user identified adoption of the new request and response
contract as a planning task on 2026-08-29. The route, HTTPS endpoint, missing
error semantics, deadline, response limit, and final migration scope still need
review.
