# A2A gateway

Status: current development architecture as of 2026-09-02

## Product

The gateway is one foreground process between a local agent runtime and the
Embassys REST API. It provides an authenticated loopback MCP server, enrolls
one email-based central identity, receives that identity's messages, and wakes
one configured webhook target.

The command remains:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The gateway does not discover a runtime, manage bindings, select a provider,
run a model, or accept central endpoint configuration from the CLI. The same
locally supplied bearer token authenticates the webhook and every call to the
gateway's loopback MCP endpoint.

## Current central baseline

The gateway targets one current development contract:

- REST base: `https://mcp.embassys.ai`
- source: `embassys/agent2agent` commit
  `b769896b7cfb1ee3540195be9e7a61cf777b9388`
- bootstrap: unversioned REST registration, verification, and resend
- protected transport: DPoP-bound token in an `Authorization: Bearer` header
  plus a separate DPoP proof header
- work model: permissions, action calls, message polling, and acknowledgement

The central service also hosts MCP and OAuth surfaces. They are not part of
the gateway architecture. The gateway does not need them because the REST API
covers its flows.

There is no parallel legacy client and no speculative next client. The older
bearer-only/MCP implementation and the proposed `/api/v2` implementation are
both removed as the live REST integration lands. Existing credentials and
state are not migrated.

The repository's current production code still contains parts of the removed
designs. Local fixture success against those designs is historical evidence,
not current central compatibility.

## System shape

```text
Local agent runtime
  |
  | authenticated loopback MCP
  v
A2A gateway on 127.0.0.1:8787
  |
  | unversioned REST
  | Bearer token plus DPoP proof after verification
  v
https://mcp.embassys.ai/api
  |
  | permission requests, action calls, and consumed messages
  v
Gateway bounded in-memory inbox and ID-only journal
  |
  | authenticated ID-only webhook wake
  v
Configured local webhook
```

An optional provider connector may own the webhook and run a local provider
runtime. That remains a separate foreground product. The existing connector
execution code was designed around the removed conversation/reply API and must
be rechecked against current permission/action messages before it can claim
live integration. It does not block the gateway REST work.

## Invariants

- One process owns one webhook target and one central identity.
- The MCP listener binds only to `127.0.0.1:8787`.
- Local MCP authentication, `Host`, and `Origin` checks happen before body
  parsing.
- Before enrollment, local MCP exposes only registration, verification, and
  resend.
- After enrollment, local MCP exposes fixed tools backed by the current REST
  routes. It does not mirror a central MCP catalog.
- Verification creates a P-256 key, submits its public JWK, intercepts the
  token, and persists the token and private key together before reporting
  success.
- Every protected REST request uses a fresh proof. The token never appears in
  an MCP argument, MCP result, URL, or log.
- Message bodies remain in bounded process memory. SQLite remains ID-only.
- The gateway holds no provider credential. A provider connector receives no
  central token or DPoP private key.
- No runtime path probes alternate central routes or negotiates an API
  version.

## Main flows

### Startup

1. Acquire the singleton lock.
2. Resolve and validate the named 48-character webhook token.
3. Bind the authenticated loopback MCP endpoint.
4. Load the current encrypted DPoP credential, if present.
5. Start REST polling only when that credential is valid and unexpired.
6. Print `http://127.0.0.1:8787/mcp` and remain in the foreground.

A development installation starts from clean gateway state. The gateway does
not read or convert old bearer credentials or speculative versioned records.

### Enrollment

1. The local agent calls `register_agent` with an email and optional display
   name.
2. The gateway sends `POST /api/register_agent`.
3. The user supplies the six-digit code delivered by email.
4. The gateway generates a P-256 key and sends its public JWK with
   `POST /api/verify_email`.
5. The gateway validates the returned key binding and timestamps.
6. It atomically stores the token and private key before returning a
   token-free result and enabling protected tools.

`resend_verification` calls the matching REST route. None of the three
bootstrap calls uses a central access token.

### Protected work

The gateway creates a fresh proof for the exact method and URL, including the
query string, and calls the REST API. The server's action catalog supplies the
available action names and JSON schemas. Permission requests and decisions
control whether `call_action` may deliver an action message to another agent.

### Receive and wake

1. The gateway long-polls `/api/poll_messages`.
2. Central marks queued messages delivered before returning them.
3. The gateway validates one bounded batch, keeps bodies in memory, and stores
   only present message IDs and relay state.
4. It sends an authenticated ID-only webhook wake.
5. The local agent retrieves the body through the gateway's MCP
   `poll_messages` tool.
6. After processing an ID-bearing message, the local agent calls
   `ack_message`.
7. The gateway removes the body and ID only after central confirms `acked`.

The current server does not redeliver a delivered message. A gateway crash can
therefore lose a body that was already returned by central. The project accepts
that limitation for development and states it plainly. Message body
persistence is still forbidden.

## Ownership

| Component | Responsibility |
| --- | --- |
| Central service | Email identities, DPoP-bound token issuance, permissions, action schemas, action calls, messages, and acknowledgements |
| Gateway | Local MCP authentication, REST projection, encrypted central credential, proof creation, bounded in-memory inbox, and ID-only webhook relay |
| Local runtime | User interaction, MCP tool use, message handling, and webhook ownership |
| Optional provider connector | Webhook admission and provider process control after its current-message integration is redesigned |
| Provider runtime | Its own authentication, history, tools, policy, and model execution |

## Current limitations

- `list_action_types` and generated OpenAPI now work. The catalog contains six
  actions, including `get_email` and `get_phone_number`, both requiring a
  string `reason`.
- `get_my_permissions` has a response-construction mismatch in source. The
  protected live check returned a server error, so the gateway keeps the
  declared response validator and fails closed.
- The server has no token refresh or reissue endpoint. An expired 30-day
  credential requires a fresh development enrollment after local state is
  intentionally cleared.
- Message receive is consuming and acknowledgement is not idempotent.
- The current source disables verification-code expiry.
- Existing provider connector code assumes central conversation and reply
  routes that do not exist and is outside the first REST integration PRs.

These limitations can be improved later. They do not justify client-side API
versioning, MCP fallback, migration code, or invented server contracts.
