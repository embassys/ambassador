# 0037 Central REST integration

Status: accepted

Date: 2026-09-01

## Problem

The gateway needs to work with the Embassys service that is being developed
and deployed. Earlier plans invented a second versioned API, central MCP
transport, token reissue, message leases, conversations, replies, and
migration behavior that the service did not implement.

Maintaining those speculative contracts made the gateway larger without
helping a supported user.

## Decision

### Follow the current server

The complete central implementation belongs in
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). The gateway
uses the live service at `https://mcp.embassys.ai`.

This decision does not freeze the integration to one server commit. When the
server changes a client-visible contract, update the gateway protocol,
fixtures, tests, implementation, and live qualification deliberately. The
gateway does not probe for versions, negotiate between contracts, or retain an
old client as a fallback.

### REST only

Bootstrap uses these public REST routes without central authorization:

| Operation | Request |
| --- | --- |
| Register | `POST /api/register_agent` with `email` and optional `display_name` |
| Verify | `POST /api/verify_email` with `email`, verification `code`, and the gateway's public `jwk` |
| Resend | `POST /api/resend_verification` with `email` |

Protected work uses these REST routes:

| Operation | Request |
| --- | --- |
| List action types | `GET /api/list_action_types` |
| Request permission | `POST /api/request_permission` |
| Grant or deny | `POST /api/respond_to_permission` |
| Deliver an action call | `POST /api/call_action` |
| Poll messages | `GET /api/poll_messages?timeout=<seconds>` |
| List permissions | `GET /api/get_my_permissions` |
| Acknowledge a message | `POST /api/ack_message` |

The gateway does not use central MCP or OAuth. It does not expose duplicate
grant and deny routes, invitation routes, or health checks as local MCP tools.

### DPoP

Verification creates an ES256 P-256 key pair and sends its public JWK in the
JSON body. It does not send a proof for verification itself.

The gateway checks that the returned token is bound to its public key. It
stores the token and private key together in the encrypted credential before
reporting token-free success.

Every protected request sends:

```http
Authorization: Bearer <DPoP-bound-token>
DPoP: <ES256-proof-JWT>
```

The proof binds a fresh identifier, the HTTP method, the exact URL, the issue
time, and the access-token hash. A nonce is absent on the first request. If the
server supplies one in a valid challenge, the gateway retries once with a new
proof. Other authentication failures do not trigger enrollment, credential
replacement, or a weaker authorization path.

### Permissions, actions, and messages

The server models agent interaction as permission requests and action calls.
The action catalog is dynamic data returned by `list_action_types`. The gateway
owns a fixed local tool catalog but does not copy central action types into new
MCP tools.

Central marks queued messages delivered before returning them from a poll.
The gateway keeps returned bodies in bounded memory and stores only message
IDs and relay state in SQLite. Acknowledgement removes local state only after
central confirms it.

Central has no delivered-message retrieval or redelivery. A crash after a
successful poll can lose the body. This remains visible as a development
limitation. The gateway does not persist message content to compensate.

### Errors and retries

The gateway maps bounded central errors to stable local failures and never
returns the remote body verbatim. It rejects redirects. It does not retry a
side-effecting call after an uncertain result. The one allowed authentication
retry is the DPoP nonce challenge described above.

### Data boundary

Tokens, private keys, proofs, verification codes, email addresses, action
payloads, permission details, messages, MCP bodies, and remote response bodies
must not enter SQLite, normal logs, diagnostics, metrics, temporary files,
crash artifacts, or support bundles. The encrypted credential is the only
approved durable location for the central token and private key.

## Consequences

The repository contains one current central client. It has no bearer-only
client, central MCP fallback, speculative versioned routes, credential
migration, token reissue, activation, lease, conversation, reply, completion,
or outcome path.

The protocol contains the exact gateway behavior. The server repository
contains the complete central API. Optional improvements to the server are
tracked separately and do not become client requirements until both projects
adopt them.
