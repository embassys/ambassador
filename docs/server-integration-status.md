# Central server integration status

Status: evidence snapshot as of 2026-09-01

This page records observed facts. ADR 0037 and the gateway protocol own the
client decision.

## Pin

- Repository: [`embassys/agent2agent`](https://github.com/embassys/agent2agent)
- Source revision:
  `b769896b7cfb1ee3540195be9e7a61cf777b9388`
- Live origin: `https://mcp.embassys.ai`
- REST prefix: `https://mcp.embassys.ai/api`

The live service does not expose a build revision. Its observed registration,
verification, and DPoP behavior matches the pinned source. The user reports
that this source has been deployed. This is the accepted development pin.

## Live observations

| Check | Result |
| --- | --- |
| `GET /health` | `200`, healthy service response |
| `POST /api/register_agent` with email and display name | `200` |
| Verification email through the real central mail path | Delivered to the disposable Mailosaur inbox |
| `POST /api/verify_email` with email, code, and P-256 public JWK | `200` with token and matching `jkt` |
| Response `jkt` and JWT `cnf.jkt` | Both matched the submitted public key |
| Bound token without a `DPoP` header | `401` |
| `Authorization: DPoP <token>` | `401` |
| `Authorization: Bearer <token>` plus a valid proof | `200` on `GET /api/poll_messages?timeout=0` |
| Valid token with a proof from another key | `401` |
| Reuse of an accepted proof | `401` |
| Initial valid proof without a nonce | Accepted; no nonce challenge required |
| `GET /api/list_action_types` with valid DPoP | `200` with six action definitions |
| `GET /openapi.json` | `200`; raw response SHA-256 `da0ddc402935c7112cebae1604a84f412c003c8d81493a566a901c199bba9544` |

No token, private key, proof, email address, or verification code was written
to the repository or printed in captured output. The disposable Mailosaur
message was deleted after use.

## Source-derived REST inventory

| Surface | Routes | Gateway use |
| --- | --- | --- |
| Health | `GET /health` | Operational check only |
| Enrollment | `POST /api/register_agent`, `POST /api/verify_email`, `POST /api/resend_verification` | Required |
| Action catalog | `GET /api/list_action_types` | Required and live-qualified |
| Permissions | `POST /api/request_permission`, `POST /api/respond_to_permission`, `GET /api/get_my_permissions` | Required |
| Actions | `POST /api/call_action` | Required |
| Messages | `GET /api/poll_messages`, `POST /api/ack_message` | Required |
| Duplicate permission helpers | `POST /api/grant_permission`, `POST /api/deny_permission` | Not used; `respond_to_permission` is canonical |
| Invitations | `GET /accept-invitation`, `GET /api/check_invitation_approval` | Human/server surface; not a gateway tool |
| MCP and OAuth | `/mcp` and discovery/registration routes | Not used by the gateway |

The source contains an invitation helper, but `request_permission` does not
call it. The shared guide's claim that first contact automatically creates an
invitation is not true for this revision.

## DPoP profile

- Key and proof algorithm: ES256 on P-256
- Verification binding: public JWK in the JSON body
- Token: HS256, 30-day configured lifetime
- Token claims: `sub`, `email`, `iat`, `exp`, `cnf.jkt`
- Protected authorization: `Authorization: Bearer <token>`
- Proof header: separate `DPoP` header
- Proof claims: `jti`, `htm`, exact `htu`, `iat`, and `ath`
- Maximum proof age: 60 seconds
- Future clock allowance: 5 seconds
- Replay key: agent plus `jti`
- Nonce: enforced only when a server-side nonce already exists; none is needed
  for the first valid request

## Message behavior

`poll_messages` updates all selected queued messages to `delivered` and returns
their full bodies. The response fields come from the database row:
`id`, `sender_agent_id`, `action_type_id`, `payload`, and `created_at`.

`ack_message` changes one delivered message to `acked`. It returns `404` when
the message is absent, already acknowledged, or not in delivered state. There
is no lease, redelivery, or delivered-message lookup.

## Source issues relevant to the client

| Issue | Effect | Plan |
| --- | --- | --- |
| `get_my_permissions` constructs username fields while its response model declares email fields | Route may return `500` | Confirm live; keep it covered but nonessential to the first action E2E |
| Verification-code expiry is set to `NULL` | Codes do not expire | Accept for current development; track as server hardening |
| Duplicate grant/deny endpoints write a different message shape | Their behavior may diverge from the canonical response route | Do not use them |
| Invitation sending helper is disconnected from permission requests | Automatic first-contact invitation is not active | Do not rely on it |
| Expiry comparison in `call_action` mixes a database timestamp with event-loop time | Expiring permissions may fail incorrectly | Use non-expiring test grants and report the server defect |

## Mailosaur handling

The development machine stores Mailosaur access in the macOS login Keychain
under service `ai.embassys.ambassador.development.mailosaur` and accounts
`api-key`, `server-id`, and `inbox-domain`. Values never belong in repository
files, `.env`, shell arguments, logs, or test output.

The live run uses unique catch-all addresses, searches only the current time
window, extracts the six-digit code in memory, and deletes the captured
message. Keep the qualification loop within the 500-message daily allowance.

## Remaining live work

- [x] Observe the fixed `list_action_types` response and pin `get_email` and
  `get_phone_number`. Both require a string `reason`.
- [ ] Confirm `get_my_permissions` after the same deployment.
- [ ] Run two disposable identities through permission request, permission
  decision, action call, poll, and acknowledgement.
- [ ] Run the packed gateway after I02 through I04 replace the old client.
- [ ] Scan all run artifacts without storing content or credentials.

Server build metadata remains desirable for a release. Generated OpenAPI and
the dynamic catalog now corroborate the pinned source.
