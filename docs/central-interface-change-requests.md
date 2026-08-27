# Central interface change requests

Status: proposed for review

These requests are ordered by importance. Items 1 through 4 define a v2 durable-handoff contract. Later items are independent improvements and must not block that handoff. None of these requests changes the published v1 gateway behavior.

`Now` describes `agent2agent-creator/agent2agent@bcddcbb4df662e04b2f5f3199740b7b79eb46cd4`, checked directly in `database.py`, `main.py`, `agent2agent_mcp.py`, and `expiry_sweep.py`. This repository's independent fixture reproduces that behavior. The supplied live tunnel returns `404`, so deployment of that revision was not checked.

## 1. Redeliver full messages until receipt

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

  ```text
  receive_messages(timeout_seconds, limit)
  ```

  ```json
  {
    "timeout_seconds": 30,
    "limit": 100
  }
  ```

  ```json
  {
    "messages": [
      {
        "id": "message_123",
        "sender_agent_id": "agent_456",
        "action_type_id": "action_789",
        "payload": {"task": "..."},
        "created_at": "2026-08-27T12:00:00Z"
      }
    ]
  }
  ```

  Reading does not change message state. Every message remains eligible for redelivery until `ack_delivery` succeeds. If messages are already waiting, the call returns immediately; otherwise it may long-poll for the requested timeout.

  A message is immutable. Every response containing the same `id` must contain the same message.

- **Why**

  ```text
  central -> return full message
  gateway -> crash before storing it
  central -> return the same message again
  ```

  Central keeps custody until the gateway confirms a durable local write. No cursor, event log, or separate content lookup is needed.

## 2. Acknowledge durable delivery

- **Now**

  Polling marks a message delivered before the gateway confirms that it retained the body. `ack_message` later mixes central delivery state with agent processing state.

- **Want**

  ```text
  ack_delivery(message_id)
  ```

  ```text
  first ack_delivery(message_123)  -> {message_id: message_123, status: received}
  second ack_delivery(message_123) -> {message_id: message_123, status: received}
  unknown message                  -> message_not_found
  ```

  `received` means the gateway has durably stored the complete message and now owns delivery to the local agent. It does not mean the agent processed the message.

  In one durable transaction, central changes the message to `received` and creates its ID-only receipt record. Only then may central delete the body or return success. The receipt record is permanent, the message ID is never reused, and every later retry returns the same `received` result. `message_not_found` is not successful receipt.

  If central later needs processing status, add a separate operation. It must not delay or weaken the custody transfer.

- **Why**

  ```text
  gateway -> commit full message locally
  gateway -> ack_delivery
  central -> record receipt, but response is lost
  gateway -> repeat ack_delivery safely
  ```

  The write order is fixed: local durable commit first, central acknowledgement second.

## 3. Require a stable immutable message ID

- **Now**

  ```json
  {
    "messages": [
      {"payload": {"task": "..."}}
    ]
  }
  ```

  The gateway accepts ID-less messages as volatile, one-shot observations.

- **Want**

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

  ```text
  message ID: 1 to 128 URI-unreserved ASCII characters
  uniqueness: within one central identity
  lifetime: never reused
  content: immutable for that ID
  ```

- **Why**

  ```text
  gateway -> stores message_123
  gateway -> ack response is lost
  central -> redelivers message_123
  gateway -> recognizes the retry instead of creating a second message
  ```

  The ID is the deduplication and acknowledgement key. It is not a cursor.

## 4. Define retention and mailbox pressure

- **Now**

  Delivered messages are deleted after 30 days even if the gateway never successfully processes them.

- **Want**

  ```text
  before ack_delivery -> retain the full message for redelivery
  after ack_delivery  -> body may be deleted; retain an ID-only receipt record
  ```

  Central must not expire, cancel, or silently delete an accepted unreceived message. Apply documented per-identity count and byte limits before accepting more work, and return a machine-readable `mailbox_full` error to the sender.

- **Why**

  Reliable handoff requires one side to own the full body at every point. Quotas reject new work rather than create an unreported gap in that ownership.

## Gateway dependency

This server contract depends on a separate gateway-v2 storage decision. Before a gateway activates v2, its ADR and protocol must define encryption keys, owner-only access, fixed count and byte limits, crash recovery, local processing acknowledgement, and body deletion ordering. The gateway reserves room for the largest permitted receive result before polling, stops receiving while its local inbox is full, and calls `ack_delivery` only after the complete message is durable.

The current v1 gateway remains memory-only with an ID-only journal. This document does not change its storage format.

## 5. Add central JWT recovery

- **Now**

  ```text
  verify_email -> one central JWT
  lost JWT -> identity cannot recover
  changed local webhook token -> stored JWT cannot decrypt
  ```

- **Want**

  ```text
  resend_verification(...)
  reissue_agent_token(verification_code, agent_id)
  revoke_agent_token(agent_id)
  ```

  ```json
  {
    "agent_id": "agent_123",
    "token": "replacement-central-jwt",
    "expires_at": "2026-09-27T12:00:00Z"
  }
  ```

  Reissue requires a fresh verification challenge and works without the lost JWT. Revocation requires a valid current JWT and invalidates it.

- **Why**

  ```text
  remote verification succeeds
  local persistence fails
  -> reissue instead of abandoning the identity
  ```

  Public use needs recovery, revocation, and intentional local reset.

## 6. Return native structured MCP results

- **Now**

  ```json
  {
    "structuredContent": {
      "result": "{'agent_id': 'agent_123', 'token': 'central-jwt'}"
    },
    "content": [
      {
        "type": "text",
        "text": "{'agent_id': 'agent_123', 'token': 'central-jwt'}"
      }
    ]
  }
  ```

- **Want**

  ```json
  {
    "structuredContent": {
      "agent_id": "agent_123",
      "username": "agent-name",
      "token": "central-jwt",
      "message": "Email verified successfully."
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
  POST /mcp/v2
  Authorization: Bearer <central-jwt>
  Content-Type: application/json
  ```

  ```json
  {
    "name": "ack_delivery",
    "arguments": {
      "message_id": "message_123"
    }
  }
  ```

  Authenticated tool schemas contain no `token` field.

- **Why**

  Authentication belongs to the connection. Tool arguments remain business data and cannot accidentally expose the JWT through schemas or results.

## 8. Version the new contract and publish stable endpoints

- **Now**

  ```text
  A2A_DEV_CENTRAL_API_URL=<temporary URL>
  A2A_DEV_CENTRAL_MCP_URL=<temporary URL>
  ```

  Gateway `0.2.5` and `0.2.6` depend on the consuming v1 behavior. They start with REST and use MCP only after an explicit REST `404`.

- **Want**

  ```text
  https://central.example/mcp/v2
  https://central.example/api/v2
  ```

  ```json
  {
    "protocol_version": "2",
    "capabilities": {
      "full_message_redelivery": true,
      "durable_delivery_ack": true,
      "idempotent_delivery_ack": true,
      "token_reissue": true
    }
  }
  ```

  Add an authenticated, idempotent `activate_delivery_v2` operation. Its single transaction:

  ```text
  queued v1 message    -> unreceived v2 message with its body
  delivered v1 message -> unreceived v2 message with its body
  acked v1 message      -> permanent received v2 tombstone
  central identity      -> v2 delivery mode
  ```

  A gateway calls this only after its durable local inbox is ready. After activation, v1 polling for that identity returns `protocol_mismatch` instead of racing the v2 receiver.

  Central must stop deleting delivered v1 rows before migration starts. An already-deleted body cannot be recovered by v2 and must not be represented as a successful receipt.

  Keep v1 endpoints and behavior unchanged for identities that have not activated v2. Deprecation or retirement requires a separate decision after published v1 gateways have migrated.

- **Why**

  A silent semantic change to `/api/poll_messages` would break published gateways. Stable URLs can become package constants instead of user configuration.

## 9. Define bounds, deadlines, and machine-readable errors

- **Now**

  Limits and wrapper errors are not one stable central contract.

- **Want**

  ```json
  {
    "limits": {
      "receive_timeout_seconds": 30,
      "max_batch_size": 100,
      "max_message_bytes": 524288,
      "max_result_bytes": 4194304,
      "max_json_depth": 100,
      "mailbox_max_messages": 10000,
      "mailbox_max_bytes": 1073741824
    }
  }
  ```

  Values above are examples; central must publish the actual fixed limits used in production.

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
  message_not_found
  mailbox_full
  protocol_mismatch
  authentication_expired
  rate_limited
  result_too_large
  ```

- **Why**

  The gateway can apply safe retry and backpressure rules without parsing remote prose. Server and client limits fail at documented boundaries.

## 10. Isolate the consuming v1 poll during migration

- **Now**

  ```text
  REST poll_messages -> consumes full messages
  MCP poll_messages  -> consumes the same queue
  ```

- **Want**

  Preferred target:

  ```text
  MCP receive_messages -> full messages without changing state
  MCP ack_delivery      -> durable custody transfer
  ```

  If REST remains:

  ```http
  GET /api/v2/messages/receive?timeout=30&limit=100
  Authorization: Bearer <central-jwt>
  ```

  ```http
  POST /api/v2/messages/message_123/ack-delivery
  Authorization: Bearer <central-jwt>
  ```

  V2 REST and MCP must use the same non-consuming queue and acknowledgement state. V1 remains on its existing endpoints and can access only identities that have not activated v2.

- **Why**

  One canonical state per identity prevents REST, MCP, v1, and v2 from racing to consume the same message.

## Target flow

```text
gateway -> receive_messages()
central -> full immutable messages
gateway -> atomically persist IDs and encrypted bodies
gateway -> sync the durable write
gateway -> ack_delivery(message_id)
central -> record receipt and release its body
gateway -> wake local webhook with message_id
agent   -> read the message from the local gateway
agent   -> acknowledge local processing
gateway -> delete the local body

gateway crashes before local commit
central -> redeliver the full message

gateway crashes after local commit but before ack_delivery
central -> redeliver the same ID
gateway -> deduplicate and repeat ack_delivery

ack_delivery response is lost
gateway -> repeat ack_delivery
central -> return the same received result
```
