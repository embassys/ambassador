# Central fixture profile

Status: target for I02 replacement tests

The replacement central fixtures model the pinned REST contract in ADR 0037.
They do not model the removed bearer-only or speculative versioned clients.

## Network

Each fixture binds a loopback address chosen by the test harness. Production
code receives the fixture origin only through an internal test seam. No
fixture URL becomes a CLI option or production default.

## Enrollment

The fixture implements:

- `POST /api/register_agent`
- `POST /api/verify_email`
- `POST /api/resend_verification`

Registration is email-based. Verification accepts a public P-256 JWK in the
body and returns a DPoP-bound token. Test helpers may reveal a deterministic
verification code to the harness, but it never appears in normal fixture
responses or gateway output.

## Tokens and proofs

The fixture signs test tokens with a fixture-only HS256 secret. Tokens last 30
days and contain `sub`, `email`, `iat`, `exp`, and `cnf.jkt`.

Every protected route requires:

```http
Authorization: Bearer <token>
DPoP: <proof>
```

The fixture independently verifies ES256 signatures, P-256 JWK thumbprints,
`jti`, exact `htm`, exact full `htu`, `iat`, `ath`, key binding, optional
server-issued nonce, and replay. It does not import the gateway proof verifier.

## Protected routes

The fixture implements:

- `GET /api/list_action_types`
- `POST /api/request_permission`
- `POST /api/respond_to_permission`
- `POST /api/call_action`
- `GET /api/poll_messages`
- `GET /api/get_my_permissions`
- `POST /api/ack_message`

Seed `get_email` and `get_phone_number` exactly as observed live. Each schema
is an object with required string property `reason`. Other catalog entries may
be fixture data only when a test needs them.

## Message state

The fixture uses the current state transitions:

```text
queued -> delivered -> acked
```

Polling changes queued messages to delivered before returning them. Delivered
messages are not returned by another poll. A repeated acknowledgement returns
not found. Restart controls may clear the process while preserving or clearing
fixture state as the individual test declares.

The fixture does not provide leases, redelivery, activation, conversations,
replies, outcomes, token reissue, revocation, central MCP, or API-version
negotiation.

## Deterministic controls

Test-only controls may:

- set or advance the clock;
- retrieve the current verification code;
- seed a registered target identity;
- create an action schema;
- create a permission or queued message;
- inspect content-free state transitions; and
- inject response loss before or after a database transition.

Controls bind only inside the test process or fixture network. They are absent
from packed artifacts and production clients.

## Data boundary

Fixtures may hold test emails, codes, payloads, messages, keys, and tokens in
memory. Test output, repository artifacts, SQLite, logs, snapshots, and package
contents must remain free of those values. Artifact tests use unique markers
and scan the complete temporary test tree before cleanup.
