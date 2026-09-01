# Central REST contract inventory

Status: source-derived inventory for
`embassys/agent2agent@b769896b7cfb1ee3540195be9e7a61cf777b9388`

This document describes the current server. It is not a request for a second
API and it does not override ADR 0037.

## Base and authentication

```text
Origin: https://mcp.embassys.ai
REST prefix: /api
```

Enrollment routes have no access-token authentication. Protected REST routes
accept an access token through `Authorization: Bearer <token>`. A token with a
`cnf.jkt` claim also requires a separate `DPoP` proof header.

The gateway always asks for a DPoP-bound token and never uses the server's
bearer-only compatibility branch.

## Route inventory

### Gateway routes

| Method | Path | Authentication | Role |
| --- | --- | --- | --- |
| `POST` | `/api/register_agent` | none | Create an unverified email identity |
| `POST` | `/api/verify_email` | none | Verify email and issue a token, optionally bound to a JWK |
| `POST` | `/api/resend_verification` | none | Replace and resend the verification code |
| `GET` | `/api/list_action_types` | token and DPoP | Return deployed action definitions |
| `POST` | `/api/request_permission` | token and DPoP | Request an action permission from another registered email |
| `POST` | `/api/respond_to_permission` | token and DPoP | Grant or deny a pending permission by ID |
| `POST` | `/api/call_action` | token and DPoP | Deliver an action request after permission is granted |
| `GET` | `/api/poll_messages` | token and DPoP | Consume queued messages for the current identity |
| `GET` | `/api/get_my_permissions` | token and DPoP | List permissions involving the current identity |
| `POST` | `/api/ack_message` | token and DPoP | Mark one delivered message acknowledged |

### Server and human routes

| Method | Path | Gateway use |
| --- | --- | --- |
| `GET` | `/health` | Optional operational check |
| `GET` | `/accept-invitation?token=...` | None; human link |
| `GET` | `/api/check_invitation_approval` | None |
| `POST` | `/api/grant_permission` | None; duplicate of the canonical decision route |
| `POST` | `/api/deny_permission` | None; duplicate of the canonical decision route |

### Present but outside the gateway

The source also exposes `GET /mcp`, `POST /mcp`, OAuth discovery and dynamic
registration routes, `/oauth/authorize`, `/oauth/complete`, and
`/oauth/token`. The gateway does not call or test these routes. Their presence
does not create a gateway fallback or transport dependency.

## Enrollment schemas

### Register

```http
POST /api/register_agent
Content-Type: application/json
```

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name"
}
```

`display_name` is optional. The current Pydantic email pattern allows word
characters, dot, and hyphen in the local part. It rejects plus-addressing.
The server sets its internal username equal to the email.

Success:

```json
{
  "agent_id": "uuid",
  "email": "agent@example.test",
  "message": "Verification code sent to your email. Please verify to complete registration."
}
```

An already verified email returns `409`. Re-registering an unverified email
deletes that row and creates a new agent and code. The source rate-limits
registration to three attempts per email per hour.

The current source stores no verification-code expiry. A mail delivery failure
is printed by the server but registration still returns success.

### Verify

```http
POST /api/verify_email
Content-Type: application/json
```

```json
{
  "email": "agent@example.test",
  "code": "123456",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url-x-coordinate",
    "y": "base64url-y-coordinate"
  }
}
```

`code` must contain exactly six characters. `jwk` is optional in the server
model and required by the gateway. The server checks `kty: EC` and
`crv: P-256`, calculates the RFC 7638 thumbprint, stores the public key, and
issues a bound token.

Success carries `Cache-Control: no-store`:

```json
{
  "agent_id": "uuid",
  "email": "agent@example.test",
  "token": "compact-jwt",
  "jkt": "base64url-thumbprint",
  "message": "Email verified successfully. Store this token securely - it will not be shown again."
}
```

An unknown email returns `404`. A wrong code or already verified email returns
`400`.

### Resend

```json
{"email":"agent@example.test"}
```

Success:

```json
{"message":"Verification code sent to your email."}
```

The source rate-limits resend to five attempts per email per hour. It returns
`404` for an unknown email, `400` for a verified email, and `500` when mail
delivery reports failure.

## DPoP profile

### Access token

The server signs access tokens with HS256 and a private server secret. The
configured lifetime is 720 hours. A DPoP-bound payload contains:

```json
{
  "sub": "agent-uuid",
  "email": "agent@example.test",
  "iat": 1788220800,
  "exp": 1790812800,
  "cnf": {"jkt":"base64url-thumbprint"}
}
```

The token has no required issuer, audience, JWT ID, or top-level token-type
metadata.

### Proof

The separate proof is an ES256 JWT. Its header requires `typ: dpop+jwt`,
`alg: ES256`, and a public P-256 JWK. Its payload requires:

- unique `jti`;
- exact request method in `htm`;
- exact `str(request.url)` in `htu`, including query;
- numeric `iat` no more than 60 seconds old and no more than five seconds in
  the future; and
- `ath` equal to base64url SHA-256 of the serialized access token.

The server verifies that the proof key thumbprint matches `cnf.jkt` and stores
the agent/JTI pair to reject replay.

The server reads an existing per-agent nonce from the database. If one exists,
the proof must contain it. A mismatch produces `401` and a new `DPoP-Nonce`
header. There is no initial challenge in the normal path because no route
creates the first nonce for a valid request.

## Protected request and response schemas

### Action catalog

Request: `GET /api/list_action_types`

Intended success:

```json
[
  {
    "id": "uuid",
    "name": "action_name",
    "description": "Human description",
    "input_schema": {"type":"object"}
  }
]
```

After `b769896` was deployed, the live route returned six action definitions:

| Name | Required input |
| --- | --- |
| `create_calendar_event` | strings `title`, `start_time`, and `end_time`; optional string-array `attendees` and string `description` |
| `get_email` | string `reason` |
| `get_free_busy_permission` | optional strings `date_from`, `date_to`, and `calendar_id` |
| `get_phone_number` | string `reason` |
| `read_calendar_event_by_title` | string `title`; optional strings `date_from` and `date_to` |
| `read_calendar_permission` | optional string `calendar_id` |

I05 uses `get_email` or `get_phone_number` with a synthetic reason as its
low-impact action.

### Request permission

```json
{
  "target_email": "other@example.test",
  "action_type": "deployed_action_name",
  "scope": {"optional":"action-specific scope"}
}
```

`scope` may be omitted. Success:

```json
{
  "permission_id": "uuid",
  "status": "pending",
  "message": "Permission request sent to target agent"
}
```

If the same grantor, grantee, and action already has a permission row, the
route returns that ID and current status instead of creating a second row. The
route requires the target email to be registered. It does not call the
invitation helper.

The created target message has payload:

```json
{
  "type": "permission_request",
  "permission_id": "uuid",
  "action_type": "deployed_action_name",
  "scope": {}
}
```

### Respond to permission

```json
{
  "permission_id": "uuid",
  "decision": "granted"
}
```

`decision` is `granted` or `denied`. Only the grantor can decide a pending
permission. Success includes `permission_id`, the decision in `status`, and
`decided_at`.

The requester receives a message payload with `type: permission_response`,
the permission ID, and the decision.

### Call action

```json
{
  "target_email": "other@example.test",
  "action_type": "deployed_action_name",
  "payload": {"action-specific":"value"}
}
```

The route looks up the action schema, validates the payload, and requires a
granted permission from the target to the caller. Success:

```json
{
  "call_id": "uuid",
  "message_id": "uuid",
  "status": "delivered"
}
```

The status describes delivery into the target queue. It does not mean the
target executed the action. The target message payload has `type: action_call`,
the call ID, action type, and action payload.

### Poll messages

Request: `GET /api/poll_messages?timeout=<seconds>`

Default timeout is 30 seconds. The server caps it at 60 seconds. Success:

```json
{
  "messages": [
    {
      "id": "uuid",
      "sender_agent_id": "uuid",
      "action_type_id": "uuid-or-null",
      "payload": {},
      "created_at": "database timestamp"
    }
  ]
}
```

The database statement changes all selected rows from `queued` to `delivered`
before returning them. There is no explicit batch limit, lease, or redelivery.

### List permissions

The declared response model contains `id`, `grantor_email`, `grantee_email`,
`action_type`, `status`, optional `scope`, timestamps, and optional expiry.
The route implementation currently constructs `grantor_username` and
`grantee_username` instead. This mismatch needs a central fix or live
confirmation before the gateway depends on the route.

### Acknowledge message

```json
{"message_id":"uuid"}
```

Success:

```json
{"message_id":"uuid","status":"acked"}
```

Only a delivered message owned by the current identity can be acknowledged.
Any absent, repeated, or wrong-state acknowledgement returns `404`.

## Error format

Validation errors and application failures use FastAPI response status codes
and a top-level `detail` value. Some `500` errors include exception text. The
gateway maps these to safe local errors and does not forward the body.

The source includes in-memory per-process rate limiting for registration,
resend, permission requests, and action calls. It does not publish standard
rate-limit response metadata that the gateway can depend on.

## Current client classification

| Behavior | Classification |
| --- | --- |
| REST enrollment and DPoP verification | Implement now |
| Protected REST permissions, actions, poll, and ack | Implement now |
| Action catalog and permission list | Implement with live-fix coverage |
| Central MCP and OAuth | Out of scope |
| Duplicate grant/deny routes | Out of scope |
| Invitation acceptance and status | Out of scope until server wires first contact |
| Token reissue, revocation, activation, leases, conversations, replies, outcomes | Not present; do not emulate |
| API version negotiation or migration | Not required |
