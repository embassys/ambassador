# 0025 Conversation and reply contract

Status: proposed

Date: 2026-08-29

## Problem

Persistent provider sessions require a stable A2A conversation identifier.
The live `poll_messages` OpenAPI schema currently leaves message items
unspecified. The representative message in protocol v1 has an `id`, sender,
action type, payload, and timestamp, but no conversation ID or reply
correlation.

The live service also has no generic reply operation. `call_action` requires a
target username, action type, and payload. An inbound message currently has a
sender agent ID, not a target username, and `call_action` does not define
conversation continuity, reply authorization, or idempotency.

The existing consuming poll also removes a message from later polls before the
local agent processes it. That crash gap is already a production blocker. A
provider turn can take much longer than a normal webhook handler, which makes
recovery a prerequisite for provider connectors rather than a later
improvement.

## Proposed decision

Add a provider-neutral conversation and reply contract to the central service.
The proposal has three parts: stable correlation, recoverable delivery, and an
idempotent reply tied to the inbound message.

### Inbound message

Every connector-eligible message has these bounded fields:

```json
{
  "id": "msg_123",
  "conversation_id": "conv_456",
  "sender_agent_id": "agent_789",
  "message_type": "request",
  "in_reply_to_message_id": null,
  "action_type_id": "action_012",
  "payload": {},
  "created_at": "2026-08-29T12:00:00Z"
}
```

`id` identifies one delivery. `conversation_id` stays unchanged for the full
back-and-forth exchange. `in_reply_to_message_id` is absent or null for an
initial request and names the directly preceding message for a response.
`message_type` must use a reviewed closed enum. The central owner must decide
which message types are connector-eligible and whether every type uses an
action type and object payload.

IDs must use the gateway's existing 1 to 128 character URI-unreserved ASCII
rule. The final schema must define required fields, nullability, duplicate-key
handling, timestamp format, JSON depth, item count, and normalized byte limits.

### Recoverable delivery

The central service must provide one of these reviewed semantics:

- redeliver every delivered but unacknowledged message after a lease expires;
  or
- let the gateway retrieve a delivered but unacknowledged message by its
  opaque ID after restart.

The operation must return the byte-equivalent logical message and must not let
one identity retrieve another identity's content. `ack_message` remains the
terminal consumption action. The gateway continues to keep message content
only in bounded process memory and stores only opaque IDs and relay state.

### Idempotent reply

Add a central REST operation and matching authenticated MCP tool with this
logical request:

```json
{
  "in_reply_to_message_id": "msg_123",
  "payload": {}
}
```

The gateway uses its stored central credential only on the upstream call. The
central service finds and authorizes the original message, routes the reply to
the original sender, assigns the same `conversation_id`, and creates the new
message. The local caller does not supply a target username, sender identity,
conversation ID, central token, or provider session ID.

The request carries a deterministic idempotency key derived from the operation
and inbound message ID. The central service scopes that key to the
authenticated identity. The exact derivation and transport location must be
specified without exposing the central JWT. Repeating the same key and same
logical request returns the same reply message ID and does not enqueue a
second reply. Reusing a key with a different request fails with a fixed
conflict response.

A successful response has an exact bounded shape:

```json
{
  "message_id": "msg_reply_345",
  "conversation_id": "conv_456",
  "status": "accepted"
}
```

The final protocol must define success status codes, authentication failures,
authorization failures, missing or already acknowledged original messages,
idempotency conflicts, validation errors, rate limits, cancellation, timeout,
and server failures. Remote error bodies are never reflected through local
MCP.

## Local gateway contract

After enrollment, expose `reply_message` only when the upstream central
service advertises the approved operation. Its local input contains only the
inbound message ID and bounded reply payload. The gateway:

1. requires the inbound message to exist in its current in-memory inbox;
2. obtains correlation and routing from that buffered message instead of local
   caller-supplied selectors;
3. authenticates the transient upstream request with the approved central
   credential mechanism and supplies the deterministic idempotency key;
4. validates the exact successful response and rejects credential-bearing or
   mismatched results; and
5. retains the inbound body until the caller separately completes
   `ack_message`.

The gateway does not retry a first reply request after an uncertain transport
outcome until the central owner specifies an idempotency status or replay
contract. Once that contract is accepted, the provider connector may repeat
the same request and key after restart. The gateway itself still does not
automatically retry side-effecting local tool calls.

If ADR 0026 is approved, the central JWT and a fresh proof travel only in the
HTTP `Authorization` and `DPoP` headers. They do not appear in REST bodies or
MCP tool arguments. Central must reject an invalid proof before reserving an
idempotency key or creating a reply.

## Terminal outcomes

The central owner must define how a provider connector reports these cases:

- completed with a response payload;
- rejected as an unsupported message type;
- failed before provider execution;
- failed after a definite provider error;
- waiting for local approval;
- cancelled; and
- uncertain after the provider may have performed side effects.

Do not encode these states as free-form error prose. Use a closed, versioned
status shape or a reviewed action response schema. Define which states are
terminal and may be followed by `ack_message`. An uncertain provider outcome
must not trigger automatic prompt replay.

## Security requirements

- Authorize replies from the stored identity against the original inbound
  message. Do not accept arbitrary sender, target, or conversation selectors.
- Scope idempotency to the authenticated identity and inbound message.
- Reject a reply when the original message does not belong to the enrolled
  identity or has already reached a terminal acknowledged state.
- Apply fixed request, response, depth, count, and time limits before any
  durable state change.
- Never include the central JWT, webhook bearer, provider session ID, or
  provider credential in a message, reply, idempotency key, URL, log, metric,
  diagnostic, or error.
- Keep message and reply bodies out of gateway SQLite, connector correlation
  state, temporary files, crash artifacts, and normal diagnostics.
- Treat reply acceptance and inbound acknowledgement as separate operations.
  Document the crash window between them and make repeated reply safe.

## Contract questions

| ID | Question | Why it blocks implementation |
| --- | --- | --- |
| C-R1 | What is the canonical conversation ID and which central operation creates it? | Connectors need one durable key across all turns. |
| C-R2 | Which message types and payload shapes may enter a provider connector? | The connector must reject unsupported work before starting a model. |
| C-R3 | Will central use lease redelivery or retrieval by delivered message ID? | The gateway cannot recover content from its ID-only journal alone. |
| C-R4 | What are the exact REST and MCP names, schemas, statuses, and error codes for reply? | Safe projection and retry behavior require an exact contract. |
| C-R5 | How is reply idempotency keyed, retained, expired, and queried after uncertainty? | A crash between reply and acknowledgement must not duplicate a response. |
| C-R6 | What terminal outcome schema covers failure, cancellation, approval, and uncertainty? | The connector cannot safely acknowledge ambiguous work. |
| C-R7 | What are the maximum message, payload, and reply sizes? | Gateway and connector bounds must agree with central limits. |
| C-R8 | Can a conversation be closed, cancelled, or reopened, and who may do so? | Session cleanup and late-message behavior depend on lifecycle rules. |

## Compatibility

Messages without a `conversation_id` remain valid for the existing runtime
flow only if protocol v1 continues to define them. A provider connector must
not invent a conversation ID from a message ID because later messages would
not map to the same provider session.

The reply operation is additive. It does not silently reinterpret
`call_action`. If the central owner decides to extend `call_action` instead,
the final contract must still provide server-derived routing, stable
conversation correlation, authorization against the original message, and
idempotent replay.

## Packaging and dependency impact

The gateway can implement this contract with its already approved HTTP, MCP,
validation, and cryptographic facilities. This proposal adds no dependency and
does not change the public gateway command. Central service implementation and
deployment choices remain owned by the central service. Any new gateway
dependency or distribution change requires a separate ADR and approval.

## Alternatives

- Use each message ID as a conversation ID. This creates a new provider session
  for every turn and loses continuity.
- Map by sender agent ID. Two concurrent conversations with the same sender
  would collide and leak context between tasks.
- Use `call_action` with a caller-supplied username. The current inbound message
  cannot supply that safely, and the operation lacks reply correlation and
  idempotency.
- Persist message bodies in the gateway to close the crash gap. This violates
  the accepted content-free durability boundary.
- Retry the provider prompt after uncertainty. This can duplicate file, MCP,
  calendar, email, payment, or other side effects.

## Approval

Not approved. The user requested planning for persistent Codex, Claude, and
Gemini conversations on 2026-08-29. The live API does not yet advertise the
required conversation, recovery, or reply contract.
