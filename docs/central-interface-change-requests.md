# Central interface change requests

Status: proposed for review

These requests are ordered by importance. They do not change the accepted v1 gateway protocol.

## 1. Add a durable message cursor

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

  Reading the response changes the message from queued to delivered. A restart cannot replay it.

- **Want**

  ```text
  watch_messages(after_cursor?, timeout_seconds, limit)
  ```

  ```json
  {
    "after_cursor": "cursor_000041",
    "timeout_seconds": 30,
    "limit": 100
  }
  ```

  ```json
  {
    "events": [
      {
        "cursor": "cursor_000042",
        "message_id": "message_123"
      }
    ],
    "next_cursor": "cursor_000042",
    "retention_floor": "cursor_000001"
  }
  ```

  `after_cursor` is exclusive. The cursor is opaque, ordered within one central identity, and safe to replay.

- **Why**

  ```text
  watch -> persist cursor and IDs -> wake
  crash -> watch from persisted cursor -> replay
  ```

  The gateway can recover after a crash without persisting message bodies.

## 2. Separate wake events from message content

- **Now**

  ```text
  poll_messages -> full body -> body becomes unavailable centrally
  ```

  The gateway must keep the body in memory until the local agent processes it.

- **Want**

  ```text
  watch_messages -> IDs only
  get_message(message_id) -> full message
  ```

  ```json
  {
    "message_id": "message_123"
  }
  ```

  ```json
  {
    "message": {
      "id": "message_123",
      "sender_agent_id": "agent_456",
      "action_type_id": "action_789",
      "payload": {"task": "..."},
      "created_at": "2026-08-27T12:00:00Z"
    }
  }
  ```

  `watch_messages` and `get_message` do not change message state.

- **Why**

  ```text
  relay path: cursor + message ID
  agent path: message body
  durable gateway state: cursor + message ID
  ```

  The relay stays ID-only. The agent can retrieve content again after a disconnect or restart.

## 3. Retain unacknowledged content and expose gap recovery

- **Now**

  ```text
  delivered by poll -> unavailable from REST and MCP
  ```

  There is no recovery operation for a delivered but unacknowledged message.

- **Want**

  ```text
  list_unacknowledged(page_token?, limit)
  ```

  ```json
  {
    "messages": [
      {"id": "message_123"},
      {"id": "message_124"}
    ],
    "next_page_token": "page_000002"
  }
  ```

  ```json
  {
    "error": {
      "code": "cursor_expired",
      "retention_floor": "cursor_000100",
      "recovery": "list_unacknowledged"
    }
  }
  ```

  Event cursors have a published retention period. Unacknowledged message content remains available until `ack_message`.

- **Why**

  ```text
  cursor valid   -> replay events
  cursor expired -> list unacknowledged IDs -> rebuild local journal
  ```

  Cursor expiry becomes a recoverable condition instead of silent message loss.

## 4. Make acknowledgement idempotent and terminal

- **Now**

  ```text
  ack_message succeeds for a message marked delivered
  duplicate and uncertain-outcome behavior is not a published interface guarantee
  ```

- **Want**

  ```text
  ack_message(message_id)
  ```

  First call:

  ```json
  {"message_id":"message_123","status":"acked"}
  ```

  Repeated call:

  ```json
  {"message_id":"message_123","status":"acked"}
  ```

  Only `ack_message` makes content unavailable.

- **Why**

  ```text
  request reached central + response lost -> repeat safely
  ```

  The gateway can resolve uncertain outcomes without duplicate processing or permanent local retention.

## 5. Require a stable ID on every message

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
  ```

- **Why**

  The ID is required for cursor replay, webhook deduplication, retrieval, and acknowledgement.

## 6. Add central JWT recovery

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

## 7. Return native structured MCP results

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

## 8. Authenticate central MCP at the transport

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
    "name": "ack_message",
    "arguments": {
      "message_id": "message_123"
    }
  }
  ```

  Authenticated tool schemas contain no `token` field.

- **Why**

  Authentication belongs to the connection. Tool arguments remain business data and cannot accidentally expose the JWT through schemas or results.

## 9. Version the new contract and publish stable endpoints

- **Now**

  ```text
  A2A_DEV_CENTRAL_API_URL=<temporary URL>
  A2A_DEV_CENTRAL_MCP_URL=<temporary URL>
  ```

  Gateway `0.2.4` depends on the consuming v1 REST behavior.

- **Want**

  ```text
  https://central.example/mcp/v2
  https://central.example/api/v2
  ```

  ```json
  {
    "protocol_version": "2",
    "capabilities": {
      "durable_cursor": true,
      "non_consuming_get": true,
      "idempotent_ack": true,
      "token_reissue": true
    }
  }
  ```

  Keep v1 unchanged until a released gateway uses v2.

- **Why**

  A silent semantic change to `/api/poll_messages` would break published gateways. Stable URLs can become package constants instead of user configuration.

## 10. Define bounds, deadlines, and machine-readable errors

- **Now**

  Limits and wrapper errors are not one stable central contract.

- **Want**

  ```json
  {
    "limits": {
      "watch_timeout_seconds": 30,
      "max_page_size": 100,
      "max_result_bytes": 524288,
      "max_json_depth": 100
    }
  }
  ```

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
  invalid_cursor
  cursor_expired
  message_not_found
  authentication_expired
  rate_limited
  result_too_large
  ```

- **Why**

  The gateway can apply safe retry rules without parsing remote prose. Server and client limits fail at documented boundaries.

## 11. Retire the consuming REST poll after MCP v2 migration

- **Now**

  ```text
  REST poll_messages -> consumes full messages
  MCP poll_messages  -> consumes the same queue
  ```

- **Want**

  Preferred target:

  ```text
  MCP watch_messages -> durable ID events
  MCP get_message    -> non-consuming content
  MCP ack_message    -> terminal acknowledgement
  ```

  If REST remains:

  ```http
  GET /api/v2/messages/watch?after=<cursor>&timeout=30&limit=100
  Authorization: Bearer <central-jwt>
  ```

  REST and MCP read the same non-destructive event log and use the same cursor rules.

- **Why**

  One canonical message state prevents REST and MCP from racing to consume the same message. The gateway needs only the MCP endpoint once `watch_messages` exists.

## Target flow

```text
gateway -> watch_messages(after_cursor)
central -> [{cursor, message_id}]
gateway -> atomically persist cursor and IDs
gateway -> wake local webhook with message_id
agent   -> get_message(message_id)
central -> full message, still unacknowledged
agent   -> ack_message(message_id)
central -> {message_id, status: "acked"}

gateway crash
gateway -> watch_messages(last_persisted_cursor)
central -> replay events within retention

cursor expired
gateway -> list_unacknowledged()
central -> IDs needed to rebuild the local journal
```
