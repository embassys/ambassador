# 0037 Central REST integration

Status: accepted; local delivery, encrypted action persistence, and permission
decisions amended by ADRs 0038, 0046, 0051, 0054, and 0057

Date: 2026-09-01

Updated: 2026-09-04

## Problem

Ambassador needs to work with the Embassys service that is being developed
and deployed. Earlier plans invented a second versioned API, central MCP
transport, token reissue, message leases, conversations, replies, and
migration behavior that the service did not implement.

Maintaining those speculative contracts made Ambassador larger without
helping a supported user.

## Decision

### Follow the current server

The complete central implementation belongs in
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). Ambassador
uses the live service at `https://mcp.embassys.ai`.

This decision does not freeze the integration to one server commit. When the
server changes a client-visible contract, update the Ambassador protocol,
fixtures, tests, implementation, and live qualification deliberately.
Ambassador does not probe for versions, negotiate between contracts, or retain
an old client as a fallback.

### REST only

Bootstrap uses these public REST routes without central authorization:

| Operation | Request |
| --- | --- |
| Register | `POST /api/register_agent` with `email` and optional `display_name` |
| Verify | `POST /api/verify_email` with `email`, verification `code`, and Ambassador's public `jwk` |
| Resend | `POST /api/resend_verification` with `email` |

Protected work uses these REST routes:

| Operation | Request |
| --- | --- |
| List action types | `GET /api/list_action_types` |
| Request permission | `POST /api/request_permission` |
| Ask the authenticated agent's owner | `POST /api/get_human_input` |
| Deliver an action call | `POST /api/call_action` |
| Submit an action result | `POST /api/submit_action_result` |
| Poll messages | `GET /api/poll_messages?timeout=<seconds>` |
| List permissions | `GET /api/get_my_permissions` |
| Acknowledge a message | `POST /api/ack_message` |

The current permission request requires at least one of `target_email` and
`message_id`. It accepts both when they identify the same grantor, with
`message_id` taking precedence. It requires exactly one of `action_type` and
`permission_type`, and accepts optional `decision_options`, `reason`, and
`scope`. Its response requires
`permission_id`, `status`, and `message`, and may include `already_granted` and
`decision`.

Ambassador does not use central MCP or OAuth. It does not expose duplicate
grant and deny routes, invitation routes, or health checks as local MCP tools.

### DPoP

Verification creates an ES256 P-256 key pair and sends its public JWK in the
JSON body. It does not send a proof for verification itself.

Ambassador checks that the returned token is bound to its public key. It
stores the token and private key together in the encrypted credential before
reporting token-free success.

Every protected request sends:

```http
Authorization: Bearer <DPoP-bound-token>
DPoP: <ES256-proof-JWT>
```

The proof binds a fresh identifier, the HTTP method, the exact URL, the issue
time, and the access-token hash. A nonce is absent on the first request. If the
server supplies one in a valid challenge, Ambassador retries once with a new
proof. Other authentication failures do not trigger enrollment, credential
replacement, or a weaker authorization path.

### Permissions, actions, and messages

The server models agent interaction as permission requests, action calls, and
correlated action results. The action catalog is dynamic data returned by
`list_action_types`. Ambassador owns a fixed local tool catalog but does not
copy central action types into new MCP tools.

For a new permission, central emails the grantor a confirmation page and does
not queue a `permission_request` to the grantor's agent. The page is read-only
on `GET` so mail scanners cannot make a decision; its form applies the human's
choice. Central then queues `permission_outcome` to the requester. A granted outcome is status only. Under ADRs 0056 and 0057, Ambassador
dispatches an explicitly saved action payload at most once. Direct and webhook
providers must not invent or submit a payload from an outcome notification. Ambassador does not expose the deployed legacy
`respond_to_permission` route, project pending permission requests into its
inbox, poll email, or submit emailed decision tokens in production.

When `decision_options` is `once_always`, central offers `allow_once`,
`allow_always`, and `deny`; the default `accept_deny` menu offers `accept` and
`deny`. One-use grants are consumed by the first successful action call. A
standing grant makes a later request return `already_granted: true` without a
new approval email.

ACP provider-tool approval uses the distinct `get_human_input` route. Central
emails the authenticated agent's own owner and later queues a
`human_input_response` back to that agent. Ambassador correlates the request to
the triggering message, presents the provider's exact options, and waits through
`poll_messages?timeout=0`. It does not use `get_human_input_status` or expose
this internal control operation as a local MCP tool.

`call_action` queues an `action_call` with a new `call_id`. Only its target may
call `submit_action_result`. The target supplies that `call_id`, a structured
result, and `success` or `error`. Central updates the action call to `completed`
or `failed` and queues one `action_response` for the original caller. A later
submission after completion returns `409`.

The result endpoint is not a general reply channel. It has no per-action output
schema, idempotency key, or outcome lookup. Ambassador therefore never retries
an uncertain result submission.

Central marks queued messages delivered before returning them from a poll.
Ambassador keeps returned bodies in bounded memory and stores only message IDs
and relay state in its journal. ADRs 0046 and 0051 define separate encrypted
inboxes for unanswered action calls and received action results.
Acknowledgement removes journal state only after central confirms it.

Central has no delivered-message retrieval or redelivery. A crash after a
successful poll can lose the body. This remains visible as a development
limitation. Ambassador does not persist message content to compensate.

### Errors and retries

Ambassador maps bounded central errors to stable local failures and never
returns the remote body verbatim. It rejects redirects. It does not retry a
side-effecting call after an uncertain result. The one allowed authentication
retry is the DPoP nonce challenge described above.

### Data boundary

Tokens, private keys, proofs, verification codes, email addresses, permission
details, unrelated messages, MCP bodies, and remote response bodies must not
enter SQLite, normal logs, diagnostics, metrics, temporary files, crash
artifacts, or support bundles. The encrypted credential is the only approved
durable location for the central token and private key. ADRs 0046 and 0051
define the only encrypted action-content exceptions.

## Consequences

The repository contains one current central client. It has no bearer-only
client, central MCP fallback, speculative versioned routes, credential
migration, token reissue, activation, lease, general conversation or reply, or
outcome-lookup path.

The protocol contains the exact Ambassador behavior. The server repository
contains the complete central API. Optional improvements to the server are
tracked separately and do not become client requirements until both projects
adopt them.
