# I02 current central contract inventory

Status: implemented and green on 2026-09-02

This inventory replaces T03, T04, and the future-version portion of C01. It
defines the missing behavior before production central clients change.

## Enrollment

| ID | Required behavior |
| --- | --- |
| I02-E01 | Pre-enrollment local MCP exposes only register, verify, and resend. |
| I02-E02 | Registration sends one `POST /api/register_agent` with email and optional display name, no username, authorization, proof, redirect, probe, or fallback. |
| I02-E03 | Resend sends one `POST /api/resend_verification` with email only. |
| I02-E04 | Verification creates P-256 key material and sends the public JWK in the JSON body with no authorization or issuance proof. |
| I02-E05 | Verification requires `Cache-Control: no-store`, intercepts the token, and returns token-free local success. |
| I02-E06 | Response `jkt`, JWT `cnf.jkt`, stored key, agent ID, email, `iat`, and `exp` are validated against the current source claims. |
| I02-E07 | Missing issuer, audience, JWT ID, token type, and 24-hour lifetime do not cause rejection. |
| I02-E08 | Persistence completes before protected tools appear or local success is returned. |
| I02-E09 | A lost or malformed verification response creates no local credential and leaks no response detail. |
| I02-E10 | Redirects, duplicate JSON members, invalid UTF-8, unsafe credential fields, oversized bodies, and unexpected cookies fail closed. |

## Credential

| ID | Required behavior |
| --- | --- |
| I02-C01 | One current encrypted record stores the token and P-256 private key atomically. |
| I02-C02 | Restart reloads that record and proves the same public thumbprint. |
| I02-C03 | Truncation, authentication failure, insecure artifacts, malformed key, malformed JWT, missing binding, expiry, and key mismatch fail before network use. |
| I02-C04 | JWT-only, earlier versioned, or unknown records are not read or migrated. |
| I02-C05 | A `401` or proof error does not delete, refresh, replace, or convert the credential. |
| I02-C06 | Built artifacts contain no legacy credential reader, reissue, recovery, or migration path. |

## DPoP transport

| ID | Required behavior |
| --- | --- |
| I02-D01 | Every protected request sends `Authorization: Bearer <token>` and one separate `DPoP` header. |
| I02-D02 | No protected request sends `Authorization: DPoP`, a token body field, an MCP token argument, or a cookie. |
| I02-D03 | Proof header uses `typ: dpop+jwt`, `alg: ES256`, and the public P-256 JWK only. |
| I02-D04 | Proof payload binds fresh `jti`, exact uppercase method, exact full URL including query, current `iat`, and correct `ath`. |
| I02-D05 | Missing proof, wrong key, wrong token hash, wrong method, wrong URL, stale time, future time, malformed signature, and replay fail before route work. |
| I02-D06 | First requests contain no proactive nonce. |
| I02-D07 | One valid `DPoP-Nonce` challenge repeats the same operation once with a new proof and the nonce. |
| I02-D08 | Duplicate, malformed, or repeated nonce challenges fail closed. |
| I02-D09 | A non-nonce `401` is terminal for the operation and never triggers bearer-only fallback or enrollment. |
| I02-D10 | No central MCP connection or request is created. |

## Protected REST tools

| ID | Required behavior |
| --- | --- |
| I02-R01 | Post-enrollment catalog contains the seven fixed REST-backed tools and no removed conversation or reissue tool. |
| I02-R02 | `list_action_types` calls `GET /api/list_action_types` and returns bounded action definitions. |
| I02-R03 | `request_permission` sends `target_email`, `action_type`, and optional `scope`. |
| I02-R04 | `respond_to_permission` accepts only permission ID plus `granted` or `denied`. |
| I02-R05 | `call_action` sends target email, action type, and payload without adding identity or credential selectors. |
| I02-R06 | `get_my_permissions` calls the current REST route, validates the declared email-field response model observed in the final protected check, and fails closed on any incompatible response. |
| I02-R07 | No local tool calls duplicate grant/deny, invitation, OAuth, health, or central MCP surfaces. |
| I02-R08 | FastAPI `detail` errors map to bounded safe local errors without reflecting the remote body. |
| I02-R09 | Side-effecting transport uncertainty causes no automatic retry. |

## Messages and webhook relay

| ID | Required behavior |
| --- | --- |
| I02-M01 | Background receive calls `GET /api/poll_messages?timeout=30` with a fresh proof. |
| I02-M02 | The gateway validates current message row fields and existing batch limits before memory or journal changes. |
| I02-M03 | Local `poll_messages` reads the in-memory inbox without a second central call. |
| I02-M04 | SQLite contains only present IDs and relay state. |
| I02-M05 | Webhook bodies remain ID-only and preserve bearer plus HMAC V2 authentication. |
| I02-M06 | `ack_message` sends one protected POST and removes local state only after the exact matching `acked` response. |
| I02-M07 | Failed or uncertain acknowledgement retains local state and is not retried automatically. |
| I02-M08 | Restart discards bodies and removes stale wake rows because central cannot redeliver them. |
| I02-M09 | No test expects lease expiry, delivered-message retrieval, idempotent acknowledgement, reply, completion, or outcome lookup. |
| I02-M10 | Artifact scans contain none of the email, code, token, key, proof, nonce, scope, action payload, or message markers. |

## Removal and packaging

| ID | Required behavior |
| --- | --- |
| I02-X01 | Runtime source and built files contain no central MCP endpoint or client path. |
| I02-X02 | Runtime source and built files contain no `/api/v2` route. |
| I02-X03 | Runtime source and built files contain no reissue, activation, lease, conversation, reply, completion, or outcome implementation. |
| I02-X04 | Runtime source and built files contain no development verbose transcript. |
| I02-X05 | Packaged smoke uses the independent current REST fixture and the same DPoP request shape as live. |
| I02-X06 | A clean-installed package runs the current Node REST fixture on each package-job platform. |

## Review gate

The red boundary was reviewed before production replacement. All current
gateway checks now pass, the independent fixture passes its five self-tests,
the packed Docker E2E passes, and old central tests were deleted or rewritten.
