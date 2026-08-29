# Central interface change requests

Status: accepted target contract, not implemented or deployment-verified

The user accepted the client-visible contracts in ADRs 0023, 0025, and 0026
on 2026-08-29. This document is the handoff to the central service owners. It
does not claim that the production service, database, shared security state,
proxy, or email system implements them.

Where production facts are unavailable, fixtures use the deterministic values
in `docs/v2-fixture-profile.md`. Those values are test-only. Central owners
must replace them with confirmed production values before staging. A material
difference in the client-visible contract returns the affected ADR for review.

The numbering groups interface topics; it is not implementation order. Central
must implement and enforce item 7's DPoP transport and item 5's DPoP token
lifecycle before item 8 can activate version 2. It then implements items 1
through 4, 9, and 10 behind that disabled activation boundary. Item 6 can land
independently. Central must not accept version 2 traffic while the same token
still works as a bearer token.

Items 1 through 4 define the v2 conversation and recovery contract. Central
retains full message content until terminal acknowledgement. The gateway
remains content-free on disk. None of these requests changes the published v1
gateway behavior for an identity that has not activated version 2.

`Now` describes `agent2agent-creator/agent2agent@bcddcbb4df662e04b2f5f3199740b7b79eb46cd4`, checked directly in `database.py`, `main.py`, `agent2agent_mcp.py`, and `expiry_sweep.py`. This repository's independent fixture reproduces the inspected contract for gateway tests. It does not prove the behavior of a deployed service. The supplied live tunnel returned `404`, so deployment of that revision was not checked.

## 1. Redeliver full messages under a lease

- **Now**

  ```http
  GET /api/poll_messages?timeout=30
  Authorization: Bearer <central-jwt>
  ```

  ```json
  {
    "messages": [
      {
        "id": "message_123",
        "payload": {"task": "..."}
      }
    ]
  }
  ```

  Returning a message changes it from `queued` to `delivered`. Future polls select only `queued`, so a failed response or gateway crash can make the body unavailable.

- **Want**

  ```http
  GET /api/v2/messages/receive?timeout=30&limit=100
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  ```

  The matching MCP tool is
  `receive_messages(timeout_seconds, limit)`. Central selects queued messages
  and messages with expired leases in one transaction. It considers them oldest
  first with message ID as tie breaker and leases only the oldest prefix that
  fits both the requested count and the exact compact UTF-8 response-body limit
  of 524,288 bytes. A row not present in that body receives no lease. Central
  never skips an oversized oldest row to lease younger work. Each selected
  message receives a lease ending 60 seconds after transaction commit. A lease
  changes delivery eligibility only. It does not acknowledge processing.

  Every unacknowledged message remains eligible after lease expiry. Central
  retains its immutable body until terminal acknowledgement. If messages are
  ready, the call returns immediately. Otherwise it may wait for the requested
  timeout.

- **Why**

  ```text
  central -> lease and return a full message
  gateway -> crash while the body exists only in memory
  central -> lease and return the same message again after 60 seconds
  ```

  Central keeps body custody until processing reaches a terminal outcome and
  the gateway acknowledges it. A lost receive response delays recovery by one
  lease but cannot lose the body.

## 2. Add immutable conversations and turns

- **Now**

  Message items have no stable conversation ID or reply link. Mapping provider
  sessions by sender would mix concurrent work from the same sender.

- **Want**

  ```json
  {
    "id": "msg_123",
    "conversation_id": "conv_456",
    "sender_agent_id": "agent_789",
    "message_type": "conversation_turn",
    "in_reply_to_message_id": null,
    "payload": {"text": "Please review the change."},
    "created_at": "2026-08-29T12:00:00.000Z"
  }
  ```

  `POST /api/v2/conversations` and MCP `start_conversation` create the
  first turn and server-generated IDs. Every later turn uses the same
  conversation ID and points to its immediate predecessor. One turn has at
  most one reply.

  `recipient_username` uses ADR 0023's exact registration validation and the
  same central canonical comparison used for registration uniqueness. The
  gateway does not normalize it. Before creating a start, central requires the
  recipient's explicit version 2 opt-in and an active recipient-owned
  `conversation.start` grant whose subject is the authenticated sender. Starts
  are default-deny. Unknown recipients, non-opted-in recipients, and senders
  without the grant all receive the same `recipient_unavailable` response
  before central reveals mailbox pressure or reserves an idempotency success.
  Grant management stays in the central control plane, not gateway CLI or
  configuration.

  Central enforces, across replicas, at most 32 active unacknowledged starts or
  8 MiB per sender-recipient pair, 1,000 such starts or 256 MiB per sender, 10
  starts per pair per rolling 60 seconds, and 60 starts per sender per rolling
  60 seconds. These are accepted client-contract and fixture values, not
  user-configurable gateway settings. Central must confirm that production can
  enforce them before deployment.

  The caller's `request_id` and REST `Idempotency-Key` are the same lowercase
  UUID v4. Central scopes them to sender and operation. It provides
  `GET /api/v2/conversation-starts/{request_id}` and MCP
  `get_conversation_start` as a sender-authorized, content-free uncertainty
  lookup. A success returns only request, message, and conversation IDs plus
  `accepted`; an unrecorded ID returns `not_found` and null result IDs.
  Central retains this record and an HMAC-SHA-256 request fingerprint for 48
  hours, then deletes them. A caller may repeat the same start after
  `not_found` only inside its caller-known 48-hour window. After that it reports
  uncertainty and requires reconciliation rather than risking a duplicate.

  IDs match `[A-Za-z0-9._~-]{1,128}`, are opaque, and are never reused.
  Version 2 accepts only strict text-only `conversation_turn` messages.
  Existing version 1 action messages remain outside provider connectors.

- **Why**

  ```text
  first turn  -> central creates conv_456 and msg_123
  reply       -> central creates msg_124 in conv_456
  next reply  -> central creates msg_125 in conv_456
  ```

  The connector can map `conv_456` to one opaque provider session without
  storing the turn text.

## 3. Add idempotent reply and outcome lookup

- **Now**

  `call_action` requires caller-supplied routing and has no conversation,
  reply authorization, or idempotency contract.

- **Want**

  ```http
  POST /api/v2/messages/msg_123/reply
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  Idempotency-Key: reply.v1.<base64url-sha256-of-message-id>
  Content-Type: application/json
  ```

  ```json
  {"payload":{"text":"The change is ready."}}
  ```

  Central authorizes the caller as the original recipient, derives the target
  from the original sender, copies the conversation ID, and creates one new
  turn. The idempotency identity is the authenticated agent ID, operation
  `reply.v1`, and inbound message ID. The matching MCP `reply_message` tool
  accepts only `message_id` and `payload`.

  Repeating the same reply returns the original message ID. Different text for
  the same idempotency identity returns `idempotency_conflict`. The first
  reply also records terminal outcome `replied` for the inbound message.

  `GET /api/v2/messages/{message_id}/outcome` and MCP
  `get_message_outcome` return content-free status. A connector uses that
  status after a lost reply response instead of storing output or replaying a
  provider prompt.

  The caller that starts a conversation owns the result wait. It retains only
  opaque request, message, and conversation IDs plus timing and closed/open
  state, and polls outcome no more than once every 30 seconds until a reply
  arrives or central records a terminal no-reply outcome. Central does not
  create a synthetic no-reply message. If polling first reports `replied`, the
  caller stops polling and waits for the normal leased reply turn. The gateway
  does not keep an outbound body or synthesize a webhook; after restart, the
  caller resumes from its opaque IDs.

- **Why**

  ```text
  central -> create one reply, then lose the HTTP response
  gateway -> query the inbound message outcome
  central -> return outcome replied and the original reply message ID
  ```

  Reply routing and deduplication do not depend on caller-supplied identity or
  conversation selectors.

## 4. Separate terminal completion from acknowledgement

- **Now**

  `ack_message` mixes delivery and processing state. It cannot describe a
  definite failure, cancellation, unsupported request, or uncertain provider
  outcome.

- **Want**

  `POST /api/v2/messages/{message_id}/complete` and MCP
  `complete_message` record one of these terminal outcomes without a reply:

  ```text
  completed_without_reply
  unsupported
  failed
  cancelled
  uncertain
  ```

  Waiting for local approval remains open. A provider disappearance after
  possible side effects becomes `uncertain` unless the adapter recovers the
  exact provider turn.

  After `reply_message` or `complete_message`, the recipient calls
  `POST /api/v2/messages/{message_id}/ack` or MCP `ack_message`. The first
  and every repeated successful acknowledgement return
  `{message_id, status: "acked"}`. Acknowledging an open message returns
  `message_not_terminal`.

  Central then removes the inbound message from receive eligibility and may
  delete its text. It retains a content-free tombstone and never reuses the
  message ID. Full unacknowledged content has no expiry. Per-identity limits of
  10,000 messages and 1 GiB reject new traffic with `mailbox_full` before
  central exceeds either limit.

- **Why**

  Reply or completion and acknowledgement are separate, idempotent
  transactions. A crash between them redelivers the inbound message, but
  outcome lookup prevents duplicate provider work or replies.

## Gateway dependency

This contract preserves the accepted gateway storage boundary. The gateway
keeps a bounded receive result in memory, stores only opaque message IDs and
relay state, and stops receiving while its in-memory inbox is nonempty. It
never writes a message or reply body to SQLite, files, logs, diagnostics,
metrics, temporary files, crash artifacts, or support bundles.

On restart, the gateway deletes stale wake rows because they have no body.
Central redelivers each unacknowledged message after its lease expires. The
gateway removes the in-memory body and journal row only after central confirms
terminal acknowledgement.

## 5. Add DPoP token reissue, recovery, and revocation

- **Now**

  ```text
  verify_email -> one central JWT
  lost JWT -> identity cannot recover
  changed local webhook token -> stored JWT cannot decrypt
  ```

- **Want**

  Implement ADR 0026's three separate operations; do not overload one
  `reissue_agent_token` tool:

  1. **Normal same-key reissue.** `POST /api/v2/token/reissue` requires the
     current DPoP token and a proof from its existing key. An exact lowercase
     UUID v4 `Idempotency-Key` returns one new 24-hour token bound to the same
     subject and key. Central keeps the encrypted successful idempotency result
     for 48 hours. The previous token remains valid to its original expiry so a
     lost response or local persistence failure does not strand the identity.
     Per ADR 0026, central retains at most eight results, accepts at most four
     previously unseen reissue keys per identity per rolling 24 hours, and
     permits at most three unexpired tokens for one identity and proof key.
  2. **Email-control recovery.** A user who has lost the token or key, changed
     the local decryption secret, or must migrate a bearer credential requests
     a generic verification resend. For an existing verified identity, central
     creates a distinct bounded recovery challenge; for a pending registration,
     it keeps ADR 0023's existing verification behavior. Both modes use the
     same non-enumerating resend response. A successful issuance-proof
     verification atomically revokes all previous tokens and issues one token
     bound to the new key. This explicit extension must be accepted together
     with ADRs 0023 and 0026; it is not the pending-registration resend behavior
     alone. Recovery keeps one active code hash for ten minutes, permits five
     code requests and ten verification attempts per email per rolling hour,
     and fails closed when the bounded shared rate store is full.
  3. **Identity-wide revocation.** `POST /api/v2/token/revoke` requires a valid
     current DPoP token and proof plus body `{"scope":"identity"}`. Before
     returning `204`, every API and MCP replica must reject every bearer and
     DPoP token for that identity.

  Credential replacement, uncertain revocation, and the user-authorized local
  reset boundary follow ADR 0026. Central never sends a recovery code, token,
  private key, proof, or nonce through an MCP business result.

- **Why**

  ```text
  remote verification succeeds
  local persistence fails
  -> request a fresh recovery code and replace the lost token through
     email-control recovery
  ```

  Normal renewal should not require email. Lost-key recovery must not trust a
  stolen bearer token, and revocation must cover every credential for the
  identity rather than only the presented token.

## 6. Return native structured MCP results

- **Now**

  ```json
  {
    "structuredContent": {
      "result": "{'message_id': 'msg_123', 'status': 'open', 'outcome': None}"
    },
    "content": [
      {
        "type": "text",
        "text": "{'message_id': 'msg_123', 'status': 'open', 'outcome': None}"
      }
    ]
  }
  ```

- **Want**

  ```json
  {
    "structuredContent": {
      "message_id": "msg_123",
      "conversation_id": "conv_456",
      "status": "open",
      "outcome": null,
      "reply_message_id": null
    }
  }
  ```

  Every tool returns native JSON matching its advertised output schema.

- **Why**

  The gateway can remove its Python-literal compatibility parser and its security-sensitive normalization path.

## 7. Authenticate central MCP at the transport

- **Now**

  ```json
  {
    "name": "ack_message",
    "arguments": {
      "message_id": "message_123",
      "token": "central-jwt"
    }
  }
  ```

- **Want**

  ```http
  POST /mcp
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  Content-Type: application/json
  ```

  ```json
  {
    "name": "ack_message",
    "arguments": {
      "message_id": "message_123"
    }
  }
  ```

  Authenticated tool schemas contain no `token` field.

  `/mcp` remains the canonical MCP endpoint. Adding message-lifecycle tools
  does not change the API/MCP endpoint pair used as ADR 0019 credential
  authenticated data. A future endpoint change requires a coordinated
  credential reissue and a separate decision before an existing credential can
  load against it.

- **Why**

  Authentication belongs to each HTTP request. Tool arguments remain business
  data and cannot expose the JWT through schemas or results. ADR 0026 defines
  proof validation, token binding, replay, and nonce behavior.

## 8. Version the new contract and publish stable endpoints

- **Now**

  ```text
  A2A_DEV_CENTRAL_API_URL=<temporary URL>
  A2A_DEV_CENTRAL_MCP_URL=<temporary URL>
  ```

  Gateway `0.2.5` and `0.2.6` depend on the consuming v1 behavior. They start with REST and use MCP only after an explicit REST `404`.

- **Want**

  ```text
  canonical API base: https://central.example
  canonical MCP endpoint: https://central.example/mcp
  v2 message routes: https://central.example/api/v2/...
  ```

  Those hostnames illustrate the shape only. The fixture profile supplies
  test-only identifiers until the central owner supplies the production
  constants. The gateway release selects v1 or v2 statically. It does
  not fetch capabilities, infer a version from verification, probe routes, or
  fall back. The MCP endpoint remains `/mcp`, so the credential endpoint pair
  does not change merely because v2 tools exist.

  Every identity begins in v1 delivery mode. After the gateway has durably
  stored an ADR 0026 DPoP credential, it calls the monotonic, idempotent
  activation transition:

  ```http
  POST /api/v2/delivery/activate
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  Content-Length: 0
  ```

  Its single transaction verifies DPoP binding, checks for no queued,
  delivered, or unrecoverable v1 row, records the recipient's explicit v2
  opt-in, and changes that identity to v2 delivery. First success and every
  repeat return `{"delivery_version":"v2","status":"active"}`.

  ```text
  empty v1 mailbox -> v2 delivery mode
  any queued row   -> migration_incomplete
  any delivered row with or without a body -> migration_incomplete
  ```

  After activation, v1 polling for that identity returns `protocol_mismatch`
  instead of racing the v2 receiver.

  A v2 gateway starts neither v1 polling nor v2 receive until it observes this
  exact success. If activation is uncertain, it repeats only activation with a
  fresh DPoP proof. DPoP issuance and enforcement therefore deploy before
  activation, and activation deploys before v2 conversation traffic.

  Existing version 1 action messages cannot be converted safely into the
  strict version 2 conversation schema. An already-deleted body cannot be
  represented as recovered. The central owner must resolve old rows before
  activation.

  Keep v1 endpoints and behavior unchanged for identities that have not
  activated v2. Deprecation or retirement requires a separate decision after
  published v1 gateways have migrated. Changing the API base or `/mcp` requires
  separately coordinated credential reissue because ADR 0019 authenticates the
  endpoint pair as credential additional data.

- **Why**

  A silent semantic change to `/api/poll_messages` would break published
  gateways. Static release selection and one atomic per-identity transition
  avoid discovery races while preserving the credential storage binding.

## 9. Define bounds, deadlines, and machine-readable errors

- **Now**

  Limits and wrapper errors are not one stable central contract.

- **Want**

  ```json
  {
    "limits": {
      "receive_timeout_seconds": 30,
      "receive_lease_seconds": 60,
      "max_batch_size": 100,
      "max_text_bytes": 262144,
      "max_receive_result_bytes": 524288,
      "max_http_response_bytes": 4194304,
      "max_json_depth": 100,
      "mailbox_max_messages": 10000,
      "mailbox_max_bytes": 1073741824,
      "sender_max_active_starts": 1000,
      "sender_max_active_start_bytes": 268435456,
      "sender_recipient_max_active_starts": 32,
      "sender_recipient_max_active_start_bytes": 8388608,
      "sender_starts_per_60_seconds": 60,
      "sender_recipient_starts_per_60_seconds": 10,
      "start_idempotency_retention_seconds": 172800,
      "non_receive_requests_per_60_seconds": 120,
      "active_receive_requests_per_identity": 1
    }
  }
  ```

  These are the accepted ADR 0025 client-contract and fixture values. Central
  must confirm them against production capacity before staging and publish the
  fixed deployed values. A required client-visible change returns ADR 0025 for
  review.

  ```json
  {
    "error": {
      "code": "rate_limited",
      "retry_after_ms": 1000
    }
  }
  ```

  Required error codes:

  ```text
  invalid_request
  recipient_unavailable
  message_not_found
  message_not_terminal
  message_already_terminal
  receive_in_progress
  idempotency_conflict
  mailbox_full
  protocol_mismatch
  migration_incomplete
  rate_limited
  request_too_large
  temporarily_unavailable
  ```

  This nested application envelope applies only after successful DPoP
  authentication. DPoP nonce, proof, and token failures use ADR 0026's flat
  issuance errors or `WWW-Authenticate: DPoP` challenges; central rejects them
  before application parsing or state change.

  Only `rate_limited` sets a positive integer `retry_after_ms`, from 1 through
  60,000. Its HTTP `Retry-After` delta seconds are
  `max(1, ceil(retry_after_ms / 1000))`. Any disagreement is a contract error.

- **Why**

  The gateway can apply safe retry and backpressure rules without parsing remote prose. Server and client limits fail at documented boundaries.

## 10. Isolate the consuming v1 poll during migration

- **Now**

  ```text
  REST poll_messages -> consumes full messages
  MCP poll_messages  -> consumes the same queue
  ```

- **Want**

  Matching MCP target:

  ```text
  MCP start_conversation     -> one authorized idempotent first turn
  MCP get_conversation_start -> content-free start uncertainty resolution
  MCP receive_messages     -> full messages under a 60-second lease
  MCP reply_message        -> one idempotent reply and terminal outcome
  MCP complete_message     -> one terminal no-reply outcome
  MCP get_message_outcome  -> content-free uncertainty resolution
  MCP ack_message          -> terminal acknowledgement
  ```

  The gateway's fixed target is REST:

  ```http
  GET /api/v2/messages/receive?timeout=30&limit=100
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  ```

  ```http
  POST /api/v2/messages/message_123/ack
  Authorization: DPoP <central-jwt>
  DPoP: <proof>
  ```

  Version 2 REST and MCP use the same start, lease, outcome, reply, and
  acknowledgement state through the canonical `/mcp` endpoint. The gateway
  uses REST without probing or fallback. Version 1 remains on its existing
  endpoints and can access only identities that have not activated version 2.

- **Why**

  One canonical state per identity prevents REST, MCP, v1, and v2 from racing to consume the same message.

## Target flow

```text
agent   -> start_conversation with an opaque UUID v4 request_id
central -> authorize recipient opt-in and sender policy, then create one turn
agent   -> on uncertainty, get_conversation_start with the same request_id
agent   -> retain opaque outbound IDs and poll get_message_outcome every 30s

gateway -> receive_messages()
central -> lease and return full immutable messages
gateway -> keep bodies in bounded memory and persist IDs only
gateway -> wake local webhook with message_id
agent   -> read the message from the local gateway
agent   -> run or resume one provider turn
agent   -> reply_message or complete_message
central -> record one terminal outcome
agent   -> ack_message
central -> stop redelivery and release the inbound body
gateway -> delete the in-memory body and ID-only journal row

gateway crashes before or after its ID-only journal write
central -> redeliver the full message after the lease

reply response is lost
gateway -> get_message_outcome
central -> return the one reply message ID

gateway crashes after reply but before ack_message
central -> redeliver the same immutable message
gateway -> observe the terminal outcome and repeat ack_message
central -> return the same acked result

recipient completes without a reply
sender  -> observe the terminal outcome through content-free polling
central -> create no synthetic conversation turn or webhook
```
