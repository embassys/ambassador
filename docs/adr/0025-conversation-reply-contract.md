# 0025 Conversation and reply contract

Status: accepted

Date: 2026-08-29

Approved: 2026-08-29

Updated: 2026-08-29 to choose lease redelivery, define the v2 message lifecycle,
and close authorization, idempotency-recovery, and activation gaps

## Problem

Persistent provider sessions need one stable A2A conversation identifier. The
live poll response has message IDs, sender IDs, action types, payloads, and
timestamps, but it does not define conversation continuity or safe replies.

The live poll also consumes a message before the local agent processes it. A
gateway crash then loses the body because the accepted gateway design permits
only opaque IDs in durable local state. Persisting message bodies in the
gateway would violate that boundary.

The central service also lacks an idempotent reply operation. A reply must not
depend on a caller-supplied target, sender, or conversation ID. A lost reply
response must not create a second outbound message when the gateway or
connector recovers.

## Decision

Add a versioned conversation API in which central keeps every full inbound
message until the recipient records a terminal outcome and acknowledges it.
Receiving creates a 60-second lease. An expired, unacknowledged lease makes the
same immutable message eligible for redelivery.

The gateway keeps received content in bounded memory and persists only opaque
IDs and relay state. It never takes durable custody of a message body.

Version 2 requires the DPoP issuance and enforcement contract in ADR 0026.
Central must not activate version 2 for a bearer credential, and the gateway
must not send DPoP proofs to a server that still accepts the same token as a
bearer token.

### Conversation model

Version 2 supports one connector-eligible message type:
`conversation_turn`. A conversation is a linear sequence. Each turn has at
most one reply, and every reply points to the turn immediately before it.
Branching, attachments, structured actions, and group conversations remain
outside this decision.

Central creates a conversation and its first turn through:

```http
POST /api/v2/conversations
Authorization: DPoP <central-jwt>
DPoP: <proof>
Idempotency-Key: 54d67b8a-b298-4e3b-923c-6f9f8ced71a5
Content-Type: application/json
```

```json
{
  "recipient_username": "target-agent",
  "payload": {
    "text": "Please review the change."
  }
}
```

Central generates both IDs. The caller cannot choose them. The matching MCP
tool is `start_conversation`. Its authenticated identity is the sender.
`recipient_username` follows the exact registration validation in ADR 0023:
3 to 50 characters, at most 200 UTF-8 bytes, with no empty value, leading or
trailing whitespace, or ASCII control character. The gateway does not rewrite
it. Central resolves it using the same canonical comparison it uses to enforce
registration uniqueness.

The caller generates `request_id` as a lowercase canonical UUID v4 matching
`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
REST carries that exact value as `Idempotency-Key`; MCP carries it as
`request_id`. A request ID is an opaque random identifier, not a place for a
username, timestamp, task description, or other meaningful data.

Resolving a username is not enough to authorize delivery. Before reserving the
request ID or creating a message, central requires all of these conditions:

1. the recipient has explicitly enabled version 2 inbound conversations;
2. central has an active recipient-owned `conversation.start` grant whose
   subject is this authenticated sender; and
3. the sender is within the sender-wide and sender-recipient abuse limits in
   this ADR.

Conversation starts are default-deny. The grant-management interface stays
central-owned and is not added to the gateway CLI or configuration. An absent
recipient, a recipient that has not opted in, and a sender without the active
grant all return the same `recipient_unavailable` response. Central performs
this non-enumerating check before exposing recipient mailbox pressure or
reserving an idempotency success.

The start idempotency identity is the authenticated sender, operation
`start.v1`, and request ID. Repeating the same recipient username and text
returns the original IDs. The first REST response uses `201`; a repeated
response uses `200`. Reusing the request ID with a different recipient or
text returns `409` with `idempotency_conflict`. Username matching is
the central registration comparison described above.

A successful start returns HTTP `201` or this exact MCP result:

```json
{
  "message_id": "msg_123",
  "conversation_id": "conv_456",
  "status": "accepted"
}
```

Central also exposes the content-free uncertainty lookup
`GET /api/v2/conversation-starts/{request_id}` and matching MCP tool
`get_conversation_start`. It is authorized only for the sender that owns the
request ID. A recorded success returns HTTP `200`:

```json
{
  "request_id": "54d67b8a-b298-4e3b-923c-6f9f8ced71a5",
  "status": "accepted",
  "message_id": "msg_123",
  "conversation_id": "conv_456"
}
```

An unrecorded ID returns HTTP `200`:

```json
{
  "request_id": "54d67b8a-b298-4e3b-923c-6f9f8ced71a5",
  "status": "not_found",
  "message_id": null,
  "conversation_id": null
}
```

Central retains the start idempotency and lookup record for exactly 48 hours
from first acceptance, then deletes it. The record contains only sender ID,
request ID, created time, status, generated IDs, and an HMAC-SHA-256 request
fingerprint under a central-only rotating secret. The fingerprint covers the
length-prefixed resolved recipient agent ID and exact decoded text bytes; it is
not a plain digest that can be tested offline against likely text. It contains
no message body or username.

The caller records the local request creation time with the opaque request ID.
Within 48 hours, `not_found` proves that it may repeat the same start safely.
After 48 hours, it must not retry that request ID or substitute a new one; it
reports an uncertain start and requires user reconciliation. This bounded
window avoids an unbounded idempotency table without silently turning a late
transport retry into a duplicate conversation.

The reply operation below creates every later turn. This keeps a conversation
linear and lets central authorize continuity from the preceding message. A
no-reply terminal outcome ends the sequence. Version 2 has no close, reopen,
branch, or append operation separate from replying to the latest turn.

### Inbound message

Every version 2 receive result contains strict objects with these keys:

```json
{
  "id": "msg_123",
  "conversation_id": "conv_456",
  "sender_agent_id": "agent_789",
  "message_type": "conversation_turn",
  "in_reply_to_message_id": null,
  "payload": {
    "text": "Please review the change."
  },
  "created_at": "2026-08-29T12:00:00.000Z"
}
```

The first turn has a null `in_reply_to_message_id`. Every later turn names the
previous message in the same conversation. Central enforces one reply per
turn, so two messages cannot name the same predecessor.

Message, conversation, and agent IDs contain 1 to 128 URI-unreserved ASCII
characters matching `[A-Za-z0-9._~-]+`. Message IDs are globally unique and
never reused. A conversation ID remains unchanged for the conversation's
life. IDs are opaque to gateway and connector code.

`created_at` is an RFC 3339 UTC timestamp with exactly three fractional-second
digits and a trailing `Z`. `payload` has exactly one key, `text`. The text
contains 1 to 262,144 UTF-8 bytes. Central and clients reject duplicate JSON
keys, unknown keys, non-finite numbers, lone UTF-16 surrogates, and values
outside these bounds.

The provider connector accepts only `conversation_turn`. Existing version 1
action messages do not acquire a made-up conversation ID and do not enter a
provider session.

### Lease-based recovery

The canonical receive operation is:

```http
GET /api/v2/messages/receive?timeout=30&limit=100
Authorization: DPoP <central-jwt>
DPoP: <proof>
```

The matching MCP tool is `receive_messages` with integer arguments
`timeout_seconds` and `limit`. The accepted ranges are 0 through 30 seconds
and 1 through 100 messages. The gateway uses 30 and 100. Central returns the
oldest eligible messages first and uses the message ID as the tie breaker.

A response has exactly one `messages` array. Central considers eligible rows in
the stable order above and packs only the oldest prefix that satisfies both the
requested count and the 524,288-byte normalized receive-result limit. The byte
calculation uses the exact compact UTF-8 JSON body central will send, including
the outer object, array delimiters, commas, member names, escaping, and every
message field. Central does not lease a row that is absent from that bounded
body. If the oldest eligible row cannot fit by itself despite satisfying the
per-message bounds, central returns `temporarily_unavailable`, leases nothing,
and quarantines the contract violation rather than skipping to younger work.

In one transaction, central selects that bounded prefix from queued messages
and messages whose leases have expired, then gives each selected message a
lease ending 60 seconds after transaction commit. A lease changes delivery
eligibility only. It does not change message content, record a terminal
outcome, or acknowledge processing.

HTTP receive returns `200`. A timeout with no eligible message returns
`{"messages":[]}`; it never returns `204`. Central allows one active receive
request per identity. A second returns `409` with `receive_in_progress`.

The same message ID always has the same logical JSON value. Object member
order and insignificant JSON whitespace do not form part of that value. A
different value for a repeated ID is a central contract violation. The
gateway stops authenticated delivery rather than choosing one body.

Central retains the full immutable message until acknowledgement. A response
lost after lease creation causes delay, not loss. The message becomes eligible
again when the lease expires. A gateway restart deletes stale local wake rows,
starts with no message body, and waits for central to redeliver the message.

The single-gateway architecture does not need lease renewal. The gateway
pauses central receive calls while its bounded in-memory inbox is nonempty.
Another process using a copied identity credential is outside the supported
single-process model.

### Idempotent reply

The recipient replies through:

```http
POST /api/v2/messages/msg_123/reply
Authorization: DPoP <central-jwt>
DPoP: <proof>
Idempotency-Key: reply.v1.<digest>
Content-Type: application/json
```

```json
{
  "payload": {
    "text": "The change is ready."
  }
}
```

`digest` is unpadded base64url SHA-256 of the UTF-8 bytes of the inbound
message ID. Central recomputes the key and rejects a missing or mismatched key.
The matching MCP tool is `reply_message` with only `message_id` and `payload`.
Central derives the same idempotency identity for MCP. It does not accept a
token, sender, target, conversation ID, provider session ID, or idempotency key
as a tool argument.

Central authorizes the authenticated identity as the recipient of the inbound
message. It derives the target from that message's sender, copies the
conversation ID, creates a new `conversation_turn`, and sets its
`in_reply_to_message_id` to the inbound message ID. The new turn's sender is
the authenticated identity.

The idempotency identity is the tuple of authenticated agent ID, operation
`reply.v1`, and inbound message ID. The first accepted call atomically records
the request digest, creates one outbound message, and records terminal outcome
`replied` for the inbound message. For conflict checks, the server stores an
HMAC-SHA-256 fingerprint of the exact decoded text bytes under a central-only
secret. It does not normalize Unicode or retain a plain content digest.

Repeating the call with the same text returns the original result and does not
create another message. Repeating it with different text returns HTTP `409`
with `idempotency_conflict`. A reply after another terminal outcome also
returns `409` with `message_already_terminal`.

A successful reply returns HTTP `200` and this exact body:

```json
{
  "message_id": "msg_reply_345",
  "conversation_id": "conv_456",
  "status": "accepted"
}
```

Reply acceptance and inbound acknowledgement remain separate. A crash between
them is safe because central redelivers the inbound message and returns the
same reply result on repetition.

### Terminal outcomes without a reply

When processing ends without a reply, the recipient calls:

```http
POST /api/v2/messages/msg_123/complete
Authorization: DPoP <central-jwt>
DPoP: <proof>
Content-Type: application/json
```

```json
{
  "outcome": "unsupported",
  "reason_code": "unsupported_message_type"
}
```

The matching MCP tool is `complete_message`. It accepts `message_id`,
`outcome`, and `reason_code`. The closed terminal outcomes and reason codes
are:

| Outcome | Allowed reason codes |
| --- | --- |
| `completed_without_reply` | `no_reply_required` |
| `unsupported` | `unsupported_message_type`, `unsupported_payload` |
| `failed` | `provider_start_failed`, `provider_execution_failed`, `provider_result_invalid` |
| `cancelled` | `cancelled_before_execution`, `cancelled_during_safe_wait` |
| `uncertain` | `provider_outcome_unknown` |

Central uses the tuple of authenticated agent ID, operation `complete.v1`, and
message ID as the idempotency identity. Repeating the same outcome returns the
same result. A different outcome or reason returns `409` with
`idempotency_conflict`. A successful call returns:

```json
{
  "message_id": "msg_123",
  "outcome": "unsupported",
  "status": "recorded"
}
```

`waiting_for_approval` is not terminal. While a provider waits for local
approval, the connector does not call `complete_message` or `ack_message` and
does not replay the provider prompt. If the provider process disappears after
it may have performed a side effect, the connector reports `uncertain` unless
the provider adapter can recover the exact turn and prove its result.

The server exposes the content-free status operation
`GET /api/v2/messages/{message_id}/outcome` and the matching MCP tool
`get_message_outcome`. HTTP returns `200` with this exact response:

```json
{
  "message_id": "msg_123",
  "conversation_id": "conv_456",
  "status": "terminal",
  "outcome": "replied",
  "reply_message_id": "msg_reply_345"
}
```

For unfinished work, `status` is `open`, `outcome` is null, and
`reply_message_id` is null. For a terminal outcome other than `replied`,
`reply_message_id` is null. This operation lets a connector resolve a lost
reply or completion response without storing a response body or rerunning a
provider turn. Central authorizes lookup for the original sender and
recipient. A sender can therefore observe a no-reply outcome by the original
message ID. Central does not synthesize another conversation turn for that
outcome because a synthetic turn could start another provider turn.

The local caller that starts a conversation owns the wait for its result. It
may durably retain only the opaque request, message, and conversation IDs plus
its creation time and closed/open state. While the request remains open, it
calls `get_message_outcome` no more than once every 30 seconds. It stops when a
normal reply turn arrives or the status becomes a terminal no-reply outcome.
If outcome lookup reports `replied` before the reply turn is delivered, it
stops outcome polling and waits for that turn through normal leased receive.
The gateway does not create a synthetic webhook, message, or durable outbound
body for this purpose. After a caller restart, the caller resumes polling from
its opaque IDs. A caller that discards those IDs accepts that no-reply outcomes
have no push notification and cannot be correlated locally.

### Acknowledgement

After observing a terminal reply or completion result, the local caller uses
`ack_message`. The canonical REST form is:

```http
POST /api/v2/messages/msg_123/ack
Authorization: DPoP <central-jwt>
DPoP: <proof>
Content-Length: 0
```

The MCP tool accepts only `message_id`. Central accepts acknowledgement after
the authenticated recipient has recorded a terminal outcome. It returns:

```json
{
  "message_id": "msg_123",
  "status": "acked"
}
```

The first acknowledgement atomically marks the inbound message acknowledged
and removes it from receive eligibility. A repeated acknowledgement returns
the same result. An open message returns `409` with `message_not_terminal`.
An unknown message or a message owned by another recipient returns `404` with
`message_not_found`.

Central may delete the acknowledged inbound text after the acknowledgement
transaction commits. It retains a content-free tombstone with the message ID,
conversation ID, participant IDs, timestamps, terminal outcome, reply message
ID, and keyed request fingerprints until the identity is deleted. Message IDs
remain reserved forever. This tombstone makes late acknowledgement and reply
retries deterministic without retaining the inbound text.

The reply is a separate outbound message. Central retains its text until its
own recipient records an outcome and acknowledges it.

## Local gateway contract

After enrollment, the gateway exposes `start_conversation`,
`get_conversation_start`, `poll_messages`, `reply_message`, `complete_message`,
`get_message_outcome`, and `ack_message` only when it uses the approved
version 2 central contract. The local `poll_messages` tool serves the current
in-memory inbox as it does in protocol v1. The relay fills that inbox through
central REST `receive`. It never forwards a local poll into a second consuming
or leasing call.

The gateway uses the REST forms in this ADR for the version 2 message
lifecycle. It does not probe or fall back to central MCP. The matching central
MCP tools share the same server state for other clients and contract fixtures.
This fixed choice prevents REST and MCP calls from racing for one gateway
identity.

The local `start_conversation` input has only `recipient_username`,
`payload`, and `request_id`. The request ID is not a credential. A caller
must reuse it to resolve an uncertain start result. The gateway never creates
a new request ID while retrying an uncertain start. The local
`get_conversation_start` input has only that `request_id` and returns the exact
content-free central result.

For each received message, the gateway:

1. validates the complete strict message and batch bounds;
2. keeps the body only in its bounded in-memory inbox;
3. stores only the message ID and webhook relay state in SQLite;
4. sends the fixed ID-only webhook wake;
5. requires a reply or terminal completion before acknowledgement; and
6. deletes the in-memory body and journal row only after central returns the
   exact acknowledged result.

The gateway requires `reply_message`, `complete_message`, and `ack_message` to
refer to a message in its current inbox. It derives correlation from that
message and rejects local sender, target, conversation, credential, provider
session, and idempotency selectors. It validates exact successful results and
never reflects a remote error body.

The gateway does not automatically retry a side-effecting reply or completion
after an uncertain transport outcome. The caller first uses
`get_message_outcome`. A terminal result allows acknowledgement. An open result
allows a retry only when the connector can recover the exact provider result.
It never permits automatic prompt replay.

In version 2, credentials and proofs travel only in the HTTP `Authorization`
and `DPoP` headers. Central MCP tool schemas contain no token arguments.

## Bounds and pressure

Version 2 uses these fixed limits:

| Value | Limit |
| --- | --- |
| Receive hold time | 30 seconds |
| Receive lease | 60 seconds |
| Messages per receive result | 100 |
| One decoded text value | 262,144 UTF-8 bytes |
| Normalized receive result | 524,288 UTF-8 bytes |
| REST request body | 524,288 UTF-8 bytes |
| HTTP response body | 4 MiB |
| JSON nesting | 100 container levels |
| URI-unreserved ID | 128 ASCII bytes |
| Active unacknowledged messages per identity | 10,000 |
| Active unacknowledged message bytes per identity | 1 GiB |
| Active unacknowledged starts per sender-recipient pair | 32 messages and 8 MiB |
| Active unacknowledged starts per sender | 1,000 messages and 256 MiB |
| Conversation starts per sender-recipient pair | 10 per rolling 60 seconds |
| Conversation starts per sender | 60 per rolling 60 seconds |

Central never silently expires or cancels an accepted, unacknowledged message.
It rejects new work before exceeding either mailbox limit. Central owners must
validate the accepted quotas against production capacity before activation. A
reply that would exceed the original sender's mailbox quota returns
`mailbox_full` and records no reply or terminal outcome. The connector keeps
the inbound message open and retries only with the same recovered provider
result.

Start-specific count and byte limits are charged to the authenticated sender,
not to a caller-supplied identity. Central enforces sender-wide, recipient
mailbox, and sender-recipient limits atomically across replicas. It evaluates
recipient policy first, so an unauthorized caller always receives
`recipient_unavailable` rather than a mailbox or pair-limit signal. An
authorized sender that reaches a count or byte limit receives `mailbox_full`;
a start-rate excess receives `rate_limited`. A rejected start does not create a
conversation, message, idempotency success, or mailbox charge.

Central permits 120 non-receive version 2 requests per authenticated identity
in a rolling 60-second window. It applies the limit across replicas. Receive
uses the one-active-request rule instead. A rate-limit response gives the
remaining delay in milliseconds and a matching `Retry-After` header. The
start-specific rate limits are subsets of this global limit, not extra request
allowances. Central owners must validate these accepted values against
production capacity before activation.

The gateway keeps the accepted 40-second deadline around a 30-second long
poll. Other central MCP and REST calls use the accepted 30-second tool-call
deadline. Clients do not automatically retry a side-effecting call after it
may have reached central.

## Errors

After successful DPoP authentication, application errors use the strict body
`{"error":{"code":"<code>","retry_after_ms":null}}`. Only
`rate_limited` sets `retry_after_ms` to the exact positive whole milliseconds
remaining, from 1 through 60,000. Its HTTP `Retry-After` delta-seconds value is
`max(1, ceil(retry_after_ms / 1000))`; the header and body are a contract
failure if they disagree. MCP returns the same application code as structured
error data. The gateway maps it to a safe local error and discards remote prose
and metadata.

| HTTP | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Syntax, schema, identifier, or bound is invalid |
| `404` | `recipient_unavailable` | Recipient is absent, not opted in, or does not permit this sender |
| `404` | `message_not_found` | Message absent or not owned by this recipient |
| `409` | `idempotency_conflict` | One idempotency identity has different logical input |
| `409` | `message_already_terminal` | Reply or completion follows a different terminal outcome |
| `409` | `message_not_terminal` | Acknowledgement precedes terminal outcome |
| `409` | `receive_in_progress` | This identity already has an active receive call |
| `409` | `protocol_mismatch` | The identity has not activated this contract |
| `409` | `migration_incomplete` | Version 1 rows prevent safe activation |
| `413` | `request_too_large` | Request exceeds the fixed byte limit |
| `429` | `mailbox_full` | Accepting a new message would exceed a mailbox quota |
| `429` | `rate_limited` | Caller exceeded the fixed request rate |
| `503` | `temporarily_unavailable` | Central cannot safely complete the operation |

DPoP proof, nonce, token, and transport-authentication errors are not
application-envelope errors. They use ADR 0026's flat issuance bodies or
`WWW-Authenticate: DPoP` challenges and required `DPoP-Nonce` headers. Central
rejects them before parsing a protected application body, acquiring a lease,
changing mailbox accounting, or writing idempotency state. The gateway handles
that challenge layer first and never tries to parse it as the nested error
object above.

Every successful REST response uses `Content-Type: application/json` and
`Cache-Control: no-store`. Start returns `201` on its first success and
`200` on an idempotent repeat. Receive, reply, completion, start lookup,
message-outcome lookup, activation, and acknowledgement return `200`. Version 2
routes never redirect. The gateway rejects redirects and never reflects a
remote response body in a local error.

## Crash behavior

| Crash or uncertain boundary | Required recovery |
| --- | --- |
| Start commits but its response is lost | Within 48 hours, query by the same UUID v4 request ID; accept the recorded IDs or repeat the same start only after `not_found` |
| A start remains uncertain after its 48-hour record expires | Do not retry either the old ID or a new ID; report uncertainty and require user reconciliation |
| Receive commits a lease but its response is lost | The same message becomes eligible after 60 seconds |
| Gateway stops before or after writing an ID-only wake row | Startup clears the stale row; central redelivers the full message |
| Connector stops before provider execution | Redelivery starts the turn once from its opaque execution state |
| Provider may have acted before the connector stops | Recover the exact provider turn or record `uncertain`; never replay the prompt blindly |
| Reply commits but its response is lost | Query outcome or repeat the same reply; central returns one reply ID |
| Gateway stops after reply and before acknowledgement | Redelivery plus outcome lookup reaches the same terminal result, then acknowledges |
| Completion commits but its response is lost | Query outcome or repeat the same completion |
| Acknowledgement commits but its response is lost | Repeat acknowledgement; central returns `acked` |
| Activation commits but its response is lost | Repeat the monotonic DPoP-protected activation operation; central returns `active` |
| Sender-side waiter restarts before a no-reply outcome | Resume 30-second outcome polling from its opaque outbound IDs; do not persist or synthesize content |
| Central stops during reply, completion, or acknowledgement | Its transaction commits all state or none of it |

No recovery path writes prompts, message text, replies, tool arguments, or
provider output to gateway or connector durable state. A connector may store
opaque message, conversation, provider session, and provider turn IDs plus a
closed execution state.

## Acceptance cases

The independent central fixtures need deterministic database time so tests do
not sleep for a lease. Production central tests must also run the lease,
reply, completion, and acknowledgement races against two service replicas
sharing one database.

| ID | Case | Expected result |
| --- | --- | --- |
| C01 | An opted-in recipient policy permits the authenticated sender, which starts with valid text and a new UUID v4 request ID | Central creates one conversation and first turn with strict server-generated IDs |
| C02 | Repeat the same start request | Return the original IDs and create no second turn |
| C03 | Reuse a start request ID with another recipient or text | Return `idempotency_conflict` and change no state |
| C04 | Start with an unknown recipient, a non-opted-in recipient, or a recipient policy that denies the sender | Return the identical `recipient_unavailable` status and body without reserving an ID or idempotency success |
| C05 | Lose a successful start response, then query by request ID within 48 hours | Return the original message and conversation IDs without returning recipient or text |
| C06 | Query an unrecorded start ID within its caller-known 48-hour window | Return `not_found`; repeating the same start creates at most one conversation |
| C07 | Expire a 48-hour start record | Delete the record; the caller reports uncertainty and does not retry |
| C08 | Reach sender-wide or sender-recipient start count, byte, or rate bounds | Reject before creating a message or idempotency success; do not reveal pressure to a denied sender |
| M01 | Receive a valid first and second turn | Both use one conversation ID; the second points to the first |
| M02 | Submit unknown keys, an invalid ID, malformed time, non-text payload, duplicate JSON keys, or oversized text | Reject before a lease or durable change |
| M03 | Try to create a second reply to one turn | Return the first result for identical text or a conflict for different text |
| D01 | Receive queued work | Lease and return the oldest stable prefix that satisfies both the requested count and exact encoded byte limit |
| D02 | Lose the receive response | Hide the message during its lease, then redeliver the same logical value after 60 seconds |
| D03 | Receive the same ID from two central replicas concurrently | One lease transaction wins; at most one response contains the message during that lease |
| D04 | Keep a message unacknowledged beyond normal retention jobs | Retain its body and redeliver it after each lease |
| D05 | Reach the count or byte mailbox limit | Reject new work with `mailbox_full`; retain every accepted message |
| D06 | Start a second receive while one is active | Return `receive_in_progress` and do not acquire another lease |
| D07 | The next eligible row would make the response exceed 524,288 bytes | Stop before that row and do not lease it; never skip it for younger work |
| R01 | Recipient replies to a valid inbound turn | Route to the original sender, preserve the conversation ID, and record outcome `replied` |
| R02 | Another identity tries to reply, complete, acknowledge, or inspect | Return `message_not_found` and change no state |
| R03 | Repeat the same reply through another replica | Return one reply ID and enqueue one outbound turn |
| R04 | Repeat a reply with different text | Return `idempotency_conflict`; preserve the first reply |
| R05 | Commit a reply and lose its response | Outcome lookup returns `replied` and the original reply ID |
| R06 | Original sender's mailbox is full | Return `mailbox_full`, leave the inbound message open, and record no reply |
| O01 | Record each allowed no-reply outcome and reason | Record one exact terminal result and return it on repetition |
| O02 | Race reply and completion through two replicas | One terminal transaction wins; the other returns `message_already_terminal` |
| O03 | Provider waits for approval | Leave the message open and do not acknowledge or replay the provider turn |
| O04 | Provider disappears after possible side effects | Recover the exact turn or record `uncertain`; never start a replacement turn blindly |
| O05 | Original sender awaits a no-reply result across a restart | Resume outcome polling at no more than one request per 30 seconds using opaque IDs only |
| A01 | Acknowledge an open message | Return `message_not_terminal` and retain the body |
| A02 | Acknowledge a terminal message twice | Return `acked` both times and make the message ineligible for receive |
| A03 | Acknowledgement response is lost | A repeat returns the same tombstone result after the body is gone |
| X01 | Kill the gateway at each receive, journal, wake, reply, completion, and acknowledgement boundary | Reach one terminal result after redelivery without a durable local body |
| X02 | Run two turns in one conversation through the fake provider | Resume one provider session and produce one reply per inbound turn |
| X03 | Restart gateway and connector after reply acceptance but before acknowledgement | Query the recorded outcome, acknowledge once, and do not rerun the provider |
| S01 | Scan gateway and connector state, SQLite, WAL, SHM, output, logs, temporary paths, and crash artifacts | Find no message text, reply text, prompt, provider output, or credential |
| V01 | Activate version 2 with an empty version 1 mailbox | Select version 2 atomically; later version 1 polls return `protocol_mismatch` |
| V02 | Activate with any queued, delivered, or unrecoverable version 1 row | Return `migration_incomplete` and leave the identity on version 1 |
| V03 | Activate with a bearer or otherwise non-DPoP credential | Reject at transport authentication and leave the identity on version 1 |
| V04 | Lose an activation success response | A repeat returns the exact `active` result without another migration |
| V05 | Exercise a version 2 release | Use fixed `/api/v2` message routes and canonical `/mcp` without capability discovery, route probes, or a changed credential endpoint pair |
| E01 | Return a version 2 application error after valid DPoP authentication | Use only the nested application envelope |
| E02 | Return a DPoP nonce, proof, or token challenge | Use only ADR 0026's flat or challenge form; perform no application work |
| E03 | Rate limit for 1, 1,001, and 60,000 milliseconds | Set `Retry-After` to 1, 2, and 60 seconds respectively |

The gateway runs these cases against the fast Node fixture on Linux, macOS,
and Windows. Ubuntu CI also runs them through the independently implemented
Python container and a packaged gateway process. Central CI owns the real
database and two-replica cases. A staging smoke test must use the canonical
HTTPS proxy before version 2 is enabled for production identities.

## Versioning and migration

Version 1 remains unchanged. A gateway release selects one delivery contract
at build and review time; it does not fetch a capability document, infer a
version from verification fields, probe routes, or fall back at runtime. The
canonical central API base and MCP endpoint pair remain the same product
constants authenticated as ADR 0019 credential additional data. In particular,
central MCP remains at the canonical `/mcp`, not `/mcp/v2`. Versioned REST
message routes live under `/api/v2` on the same canonical API base. Changing
either authenticated endpoint value requires a separately reviewed credential
reissue and migration before the gateway can load the old credential.

Every identity starts in version 1 delivery mode. After a version 2 gateway has
completed ADR 0026 verification or email-control migration and durably stored a
valid DPoP credential, it calls this fixed operation:

```http
POST /api/v2/delivery/activate
Authorization: DPoP <central-jwt>
DPoP: <proof>
Content-Length: 0
```

The operation is monotonic and idempotent. In one transaction central verifies
that the credential is DPoP-bound and the version 1 mailbox has no queued,
delivered, or unrecoverable row, then records this authenticated call as the
recipient's explicit version 2 opt-in and changes only that identity's delivery
mode to version 2. First success and every repeat return:

```json
{
  "delivery_version": "v2",
  "status": "active"
}
```

Version 1 action messages do not match the strict version 2 conversation
schema, and a deleted body cannot be synthesized as recovered. Central returns
`migration_incomplete` while any such row remains. If activation fails or its
response is uncertain, the gateway remains activation-blocked and repeats only
this idempotent operation with a fresh DPoP proof. It starts neither version 1
polling nor version 2 receive until it has observed the exact success response.

After activation, version 1 polling for that identity returns
`protocol_mismatch`; version 2 is the only delivery contract for it. Older
gateways and identities that have not activated continue to use unchanged
version 1 endpoints. This is an atomic state transition, not runtime discovery.
DPoP enforcement must ship first, activation second, and version 2 conversation
traffic last.

## Security requirements

- Central accepts a new conversation only after authenticated-sender checks,
  recipient opt-in and policy authorization, and abuse-limit enforcement. The
  common `recipient_unavailable` response does not reveal which check failed.
- Central authorizes reply, completion, and acknowledgement against the
  authenticated recipient. It permits outcome lookup by the original sender
  or recipient. It returns `message_not_found` to every other identity to
  avoid an ownership oracle.
- Central scopes start lookup to the authenticated sender and returns no
  recipient, text, or content-derived plain digest.
- Reply routing comes only from the immutable inbound record.
- Central rejects duplicate JSON keys and invalid bounds before a lease or
  durable change.
- Message text and reply text never enter gateway or connector SQLite,
  configuration, logs, diagnostics, metrics, temporary files, crash artifacts,
  or support bundles.
- JWTs, DPoP keys, webhook tokens, provider credentials, and provider session
  IDs never enter messages, idempotency keys, URLs, errors, or central logs.
- Normal diagnostics may contain operation names, safe error codes, counts,
  durations, and opaque IDs only where the accepted logging policy permits
  them.
- DPoP authentication completes before version 2 application parsing or state
  change, and DPoP-bound tokens never enter bearer validation.

## Alternatives

- Retrieve a delivered message by ID. That closes the crash gap, but lease
  redelivery also covers a response lost before the gateway learns the ID.
- Persist message bodies in the gateway. This violates the accepted
  content-free durability boundary and creates key, quota, deletion, backup,
  and migration work on every client platform.
- Treat a message ID as a conversation ID. Each turn would start a new provider
  session.
- Map sessions by sender ID. Concurrent conversations with one sender would
  share context.
- Reuse `call_action` with a caller-supplied reply target. That does not prove
  reply authorization and permits misrouting.
- Retry a provider prompt after uncertainty. The prompt may have already
  changed files or called an external tool.

## Accepted choices and production confirmations

The user accepted these architectural choices on 2026-08-29. Central owners
must implement them and confirm the production deployment facts below:

- lease redelivery instead of retrieval by message ID;
- a 60-second lease with no renewal in the one-gateway model;
- strict text-only, linear conversations with one reply per turn;
- server-generated conversation IDs through `start_conversation`;
- recipient opt-in plus a default-deny recipient-owned `conversation.start`
  grant, with one
  non-enumerating denial;
- UUID v4 start IDs, a content-free 48-hour start lookup, and no retry after
  that recovery window;
- deterministic reply identity from authenticated recipient and message ID;
- a separate terminal outcome followed by idempotent acknowledgement;
- sender-owned 30-second outcome polling without a synthetic no-reply turn;
- REST as the gateway's fixed message-lifecycle interface;
- release-selected v2 with one monotonic activation operation, no capability
  discovery, and the canonical MCP endpoint kept at `/mcp`;
- DPoP enforcement as a prerequisite for activation;
- count-and-byte-aware lease packing and rounded `Retry-After` values;
- permanent content-free tombstones and no expiry for unacknowledged content;
- keyed content fingerprints instead of durable plain content digests; and
- the concrete mailbox, sender, pair, and request-rate limits above.

Central owners must confirm these deployment facts before production
activation:

1. The canonical API base, canonical MCP `/mcp` endpoint, and exact version 2
   REST route names, without changing the ADR 0019 authenticated endpoint pair.
2. The central registration uniqueness and comparison rule for the ADR 0023
   username grammar, including case and Unicode behavior.
3. The recipient-owned opt-in and sender-policy representation and how users
   review or revoke it outside the gateway.
4. Database transactions can atomically apply sender and pair pressure,
   create a start and its 48-hour recovery record, pack and lease a byte-bounded
   batch, create one reply, record terminal outcomes, acknowledge, and activate
   one delivery version across service replicas.
5. The central secret lifecycle for keyed request fingerprints covers every
   retained fingerprint without exposing likely message text to offline tests.
6. Replica clocks and database time can enforce the 60-second lease, 48-hour
   start window, and rolling request limits without process-local timing.
7. The accepted mailbox, sender, pair, byte, and request-rate limits and
   indefinite unacknowledged retention fit production capacity.
8. Migration can identify every version 1 row whose body has already been
   deleted and can keep an identity blocked until central resolves it.
9. ADR 0026 issuance, recovery, and every REST and MCP resource endpoint can
   enforce DPoP before version 2 activation is enabled.

## Packaging and dependency impact

The gateway can implement this contract with its approved HTTP, MCP,
validation, SQLite, and cryptographic facilities. This decision adds no
gateway dependency and does not change the public gateway command. Central
implementation choices remain central-owned. Any connector dependency,
command, state format, installation path, or publishing plan needs separate
approval.

## Approval

The user approved this conversation, reply, and recovery contract together
with ADRs 0023 and 0026 on 2026-08-29. The approval freezes the gateway and
fixture contract. The central service must implement the accepted API,
transactions, limits, and DPoP enforcement before production activation.
