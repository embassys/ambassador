# In-memory central test fixture

This Docker fixture implements the central HTTP and MCP contracts needed by
gateway tests. It contains no source from the central service. Process exit or
`POST /__test/reset` clears all state.

The fixture is not a production server. Its issuer, audiences, keys, accounts,
codes, clock, and control routes are test values from
`docs/v2-fixture-profile.md`.

## Version boundary

Version 1 remains available for shipped `0.2.6` compatibility:

- Headerless Streamable HTTP requests to `/mcp` use the v1 tool catalog.
- V1 authenticated MCP tools accept a `token` argument.
- `GET /api/poll_messages?timeout=<0..30>` consumes queued messages with a
  bearer token.
- `POST /api/ack_message` acknowledges a delivered v1 message with a bearer
  token.

Requests to `/mcp` that contain `Authorization` or `DPoP` select the v2 MCP
catalog. The fixture authenticates every such HTTP request with the MCP DPoP
security domain before JSON-RPC dispatch. The v2 tools are
`list_action_types`, `request_permission`, `respond_to_permission`,
`call_action`, `get_my_permissions`, `start_conversation`,
`get_conversation_start`, `receive_messages`, `reply_message`,
`complete_message`, `get_message_outcome`, `ack_message`, and `health_check`.
Their schemas have no token argument. Protected business tools derive the
caller from DPoP transport authentication and use the same permission and
action state machine as the v1 tools.

## Version 2 HTTP contract

Bootstrap routes use fixed REST requests:

- `POST /api/register`
- `POST /api/resend_verification`
- `POST /api/verify_email`

Verification requires an ES256 issuance proof. Its first valid proof without a
nonce receives the accepted `400 use_dpop_nonce` challenge. A successful
verification returns a 24-hour DPoP-bound token and `Cache-Control: no-store`.
Verification codes are invalid at their exact expiry instant.
Registration and resend reject both credential headers. Verification rejects
`Authorization` and requires exactly one `DPoP` header. The fixture validates
the issuance proof and nonce before it reads or parses the verification body.

All protected routes require `Authorization: DPoP <token>` and a fresh proof:

- `POST /api/v2/delivery/activate`
- `POST /api/v2/conversations`
- `GET /api/v2/conversation-starts/{request_id}`
- `GET /api/v2/messages/receive?timeout=<0..30>&limit=<1..100>`
- `POST /api/v2/messages/{message_id}/reply`
- `POST /api/v2/messages/{message_id}/complete`
- `GET /api/v2/messages/{message_id}/outcome`
- `POST /api/v2/messages/{message_id}/ack`
- `POST /api/v2/token/reissue`
- `POST /api/v2/token/revoke`

The fixture rejects bearer use of a DPoP-bound token. It verifies the proof
signature, public-key binding, method, normalized external URI, token hash,
clock, nonce, and one-use proof ID before application dispatch. Message receive
uses a 60-second lease. Clock controls let tests check redelivery without
sleeping.

URI validation uses the raw encoded request path, excludes the query, preserves
consecutive and trailing slashes, normalizes percent-encoding case, removes dot
segments, lowercases the scheme and host, and removes default ports. Bootstrap,
v2 REST, and MCP routes are exact; their trailing-slash variants return `404`
and never redirect.

Protected REST and MCP requests require exactly one `Authorization` header.
Missing, repeated, or malformed authorization returns `invalid_token`. With one
valid authorization header, missing or repeated `DPoP` returns
`invalid_dpop_proof`. Same-key reissue is rejected at the credential's issuance
instant. Once the deterministic clock advances, a successful reissue has a
later expiry and a new exact 24-hour lifetime.

An accepted conversation start remains exactly retryable after its sender
grant is revoked, while changed input conflicts. Start IDs are scoped by
authenticated subject within `start.v1`. Reissue IDs are global across
subjects, and reuse between `start.v1` and `reissue.v1` conflicts.

T02 tests can run a separate public loopback proxy and internal fixture
listener on runtime-assigned ports. The public listener fixes one external
origin, removes `Forwarded`, every `X-Forwarded-*` field, caller `Host`, the
old `X-A2A-Test-Proxy` marker, and the fixture-private proxy authorization
field. It then sends its own scheme, host, and port fields to the internal
listener. A random per-run credential authenticates that internal hop. The
credential stays in the two test applications' process memory and is not
returned by readiness, inspection, profile, error, or proxy responses.
The internal HTTP client ignores `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
related process-environment settings so those values cannot reroute DPoP or
the fixture-private credential. A hostile environment-proxy test covers this
boundary with a protected request.

The internal fixture reconstructs DPoP `htu` from those fields only when the
private credential matches. Direct internal calls, an incorrect credential,
and caller forwarding fields use the direct request origin instead. The
network tests sign the same public URI for direct and proxied requests, cover
reserved and unreserved percent encodings, exclude query strings, and verify
that both listeners shut down without leaving the proxy HTTP client open.
Uvicorn proxy-header handling is disabled in this harness so only the fixture's
explicit trust rule can change the external URI. This is test support, not a
production proxy or forwarding policy.

Bootstrap request bodies are limited to 2 KiB. Protected REST request bodies
are limited to 512 KiB, and DPoP authentication happens before a protected body
is read. The fixture enforces both limits incrementally for streamed requests
without consuming the unread tail after the limit is crossed.

The deterministic v2 clock starts at `1788000000`. Enrollment and recovery use
code `123456`. Reset restores these seeded identities:

| Username | Email | Delivery state |
| --- | --- | --- |
| `fixture_sender` | `fixture_sender@fixture.invalid` | v2 active |
| `fixture_recipient` | `fixture_recipient@fixture.invalid` | v2 active, permits starts from `fixture_sender` |
| `fixture_denied` | `fixture_denied@fixture.invalid` | v2 active, no sender grant |
| `fixture_legacy` | `fixture_legacy@fixture.invalid` | v1 with a blocking legacy row and a seeded v1 verification record |

The four v2 identity records are verified but have no exposed credential.
Tests request a recovery code through `resend_verification`, read it through
the protected control route, and run normal DPoP verification with their own
P-256 key. The `fixture_legacy` v1 companion starts unverified at the same
email. Tests can obtain its bearer through the normal v1 verification flow.
That bearer is an ES256 JWT with the fixture issuer, identity subject, ordered
v2 audiences, and no DPoP confirmation claim. Recovery preserves its issuer,
subject, and audience identity while adding the new key binding.
Completing v2 email recovery invalidates that bearer and every older DPoP
credential for the central identity; its blocking legacy row still prevents v2
delivery activation.

## Test controls

Every control request requires
`X-A2A-Test-Key: central-fixture-control`. Inspection and profile responses are
content-free. They do not return email addresses, codes, tokens, private keys,
proofs, nonces, or message text.

Version 2 controls are:

| Route | Body or result |
| --- | --- |
| `POST /__test/v2/verification-code` | `{"email":"agent@fixture.invalid"}` |
| `POST /__test/v2/clock` | `{"seconds":60}` advances the clock by 0 through 604800 seconds |
| `POST /__test/v2/grants` | `{"sender_username":"...","recipient_username":"...","active":true}` |
| `POST /__test/v2/messages` | Sender username, recipient username, text, and optional conversation or predecessor ID |
| `POST /__test/v2/faults` | `{"operation":"receive","mode":"drop_after_commit"}` |
| `POST /__test/v2/inspect` | Optional `agent_id` and `message_id` filters |
| `GET /__test/v2/profile` | Fixture issuer, audiences, public issuer JWK, and seeded agent IDs |
| `POST /__test/v2/nonce-key/rotate` | No body |

Fault operations are `register`, `verify`, `resend`, `activate`, `start`,
`receive`, `reply`, `complete`, `ack`, `reissue`, and `revoke`. Modes are
`none`, `unavailable_before`, `drop_after_commit`, `nonce_once`, and
`invalid_success`. A drop-after-commit fault returns a safe `503` after the
in-memory transaction commits. Inspection can then confirm the content-free
state change.

The original v1 controls remain available at `POST /__test/verification-code`,
`POST /__test/messages`, and `POST /__test/inspect`. `POST /__test/reset`
resets both versions.

## Container tests

`requirements.lock` contains CPython 3.13 manylinux x86-64 wheel hashes. Build
and test on `linux/amd64`:

```sh
docker build --platform=linux/amd64 --target test --tag a2a-central-fixture-test .
```

Run the fixture locally with:

```sh
docker build --platform=linux/amd64 --tag a2a-central-fixture .
docker run --rm --platform=linux/amd64 -p 127.0.0.1:8000:8000 a2a-central-fixture
```

The runtime image uses one non-root Uvicorn worker, disables access logging,
and mounts no volume.
