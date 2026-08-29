# Version 2 fixture profile

Status: accepted for tests only

Date: 2026-08-29

This profile supplies deterministic stand-ins for production facts that central
has not published. It applies only to the Node and Docker central fixtures and
their tests. ADRs 0023, 0025, and 0026 remain the normative protocol contract.

## Network and identity values

Each fixture binds its public listener to `127.0.0.1:0`, then reports the
runtime-assigned origin to the test process. The API base is that origin and
the MCP endpoint is `<origin>/mcp`. Plain HTTP is valid only because the peer is
literal loopback. Tests derive every DPoP `htu` from the reported origin.

The fixtures use these sentinel JWT and security-domain values:

| Value | Fixture constant |
| --- | --- |
| Issuer | `urn:a2a:fixture:issuer:v2` |
| API audience | `urn:a2a:fixture:resource:api:v2` |
| MCP audience | `urn:a2a:fixture:resource:mcp:v2` |
| Issuance security domain | `a2a-fixture-issuance-v2` |
| API security domain | `a2a-fixture-api-v2` |
| MCP security domain | `a2a-fixture-mcp-v2` |

These values are intentionally unsuitable for production. Production code
must reject fixture control headers, `.invalid` fixture identities, fixture
URNs, and non-loopback HTTP. It must not use this document to choose product
URLs, issuer values, audiences, proxy peers, signing keys, quotas, or rollout
dates.

## Wire contract

Both fixtures implement the exact methods, paths, request and response
projections, status codes, headers, limits, and error bodies accepted in ADRs
0023, 0025, and 0026. They do not add aliases, schema extensions, route probes,
MCP token arguments, bearer fallback, or compatibility responses.

DPoP enforcement is active from fixture startup. Verification requires an
issuance proof. Every protected REST request and every authenticated `/mcp`
request requires `Authorization: DPoP` and a valid fresh proof. A DPoP-bound
token presented as bearer authentication fails before application dispatch.
The fixture has no mode in which version 2 accepts bearer tokens. Delivery
activation remains the explicit monotonic operation from ADR 0025.

## Deterministic data

The default clock starts at NumericDate `1788000000`. A test-control operation
advances it by an exact whole number of seconds. Tests never sleep to cross a
proof, nonce, lease, idempotency, token, or recovery boundary.

Fixture reset restores all of these values:

- enrollment and recovery verification code `123456`, with the accepted
  ten-minute lifetime;
- monotonic URI-unreserved IDs such as `agent_fixture_0001`,
  `conv_fixture_000001`, and `msg_fixture_000001`;
- a fixed canonical UUID v4 sequence for server-generated token IDs and test
  request vectors;
- fixed fixture-only P-256 issuer and DPoP test keys;
- fixed fixture-only nonce-MAC and keyed-fingerprint secrets; and
- zeroed counters followed by the seeded identities below.

Private test keys live only in test-vector assets and process memory. Normal
test output, fixture status operations, logs, diagnostics, and artifacts must
not return them. Production key generation and UUIDs continue to use the
operating system cryptographic random source.

The reset seed contains:

| Username | Delivery state | Conversation policy |
| --- | --- | --- |
| `fixture_sender` | Version 2 active | Inbound enabled |
| `fixture_recipient` | Version 2 active | Inbound enabled, active `conversation.start` grant for `fixture_sender` |
| `fixture_denied` | Version 2 active | Inbound enabled, no grant for `fixture_sender` |
| `fixture_legacy` | Version 1 | No version 2 opt-in |

Tests may register more identities through the accepted enrollment API. Seeded
identities are fixture state, not production bootstrap accounts.

## In-memory state

One fixture state object owns agents, codes, grants, delivery versions,
messages, leases, start and reply idempotency records, outcome tombstones,
proof replay claims, nonce key-ring state, token issuance counts, encrypted
reissue results, revocations, and recovery limits. Fixture reset clears the
object and reapplies the deterministic seed. Process restart clears it without
trying to mimic production durability.

Clock advancement drives the accepted 60-second lease, 65-second replay
retention, five-minute nonce window, ten-minute recovery-code lifetime,
24-hour token lifetime, and 48-hour idempotency windows. Fault controls may
drop a response after its transaction commits, but they must not change the
transaction or return message content through a control endpoint.

## Trusted proxy simulation

Proxy tests use a separate public loopback listener and an internal fixture
listener, both on runtime-assigned ports. The public listener removes supplied
forwarding fields, adds its own external scheme, host, and port values, and
marks the internal call as coming from the one fixture-trusted proxy peer. The
application reconstructs `htu` from those values only for that peer. Direct
internal requests and spoofed forwarding fields are untrusted and cannot
alter `htu`.

The direct and proxied paths must produce the same normalized target for the
same public URI. This simulation does not choose a production proxy product,
network range, forwarding-header policy, or TLS termination design.

## Dependency scope and remaining gates

ADR 0020 approves direct test-only use of the existing hash-locked
`cryptography==50.0.0` wheel for independent P-256 and ECDSA operations in the
Docker fixture. It does not approve another JWT, JOSE, OAuth, HTTP, or
validation dependency. The fixture owns strict DPoP parsing and validation and
must not import gateway proof code as a shortcut.

Fixture server reset is a test-control operation. It does not authorize a
gateway command, MCP tool, file deletion, or production identity reset. The
local interface for unreadable credentials, uncertain revocation, and
intentional identity reset remains blocked on user review.

## Approval

The user approved ADRs 0023, 0025, and 0026 on 2026-08-29 and authorized
fixture-only stand-ins for unavailable production facts. Those stand-ins may
drive fixtures and red tests. They must never become production defaults. The
user also approved ADR 0020's exact fixture-only cryptography amendment on
2026-08-29, completing D06.
