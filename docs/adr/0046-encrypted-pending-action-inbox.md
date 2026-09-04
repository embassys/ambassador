# 0046 Encrypted pending-action inbox

Status: accepted; agent-facing view amended by ADR 0052

Date: 2026-09-03

## Problem

A pending permission request and an unanswered action call are different. The
former remains queryable from central until its owner grants or denies it. The
latter may already have permission and delivery, but still need information
only the local user can provide. For example, an agent can receive
`get_phone_number` while the user is away and cannot safely invent the number.

Central has no route to list pending action calls. Its consuming message poll
marks a call delivered before returning it, so Ambassador cannot retrieve that
body later. Keeping only the notification ID would make a later answer
impossible after acknowledgement or restart.

## Decision

- Add the zero-argument MCP tool `list_pending_action_calls`. It returns a count
  and each unanswered call's `call_id`, `sender_agent_id`, `action_type`,
  `payload`, and `created_at`.
- Do not add or probe a central endpoint. The view comes from local Ambassador
  state.
- Before delivering or acknowledging a validated `action_call`, store those
  five fields in a separate encrypted SQLite inbox. Do not store the outer
  message ID or any other message type.
- Encrypt every row with AES-256-GCM. Derive a domain-separated encryption key
  from the loaded DPoP private key and key thumbprint, use an HMAC lookup key
  instead of the plaintext call ID, and keep the existing owner-only directory,
  link, permission, schema, and SQLite safety checks.
- Bound the inbox to 256 calls and 480 KiB of ciphertext. A duplicate with the
  same exact content is idempotent; a conflicting duplicate fails closed.
- If an agent cannot answer without unavailable user input, it leaves the call
  pending. A later agent session can list the call, collect the user's answer,
  and invoke the existing `submit_action_result` tool.
- Remove the local record only after central returns a valid successful result
  submission. `ambassador clean` removes the complete inbox with the rest of
  local identity state.
- Keep the notification journal ID-only. This inbox is not a general message
  store, delivery-control surface, replay queue, or chat history.

## Consequences

The user can answer an action asynchronously even after the delivery turn ends
or Ambassador restarts. Webhook and direct delivery use the same inbox and MCP
tools. Permission decisions continue to use the central projection from ADR
0045.

This is a deliberate narrow exception to ADR 0038's previous prohibition on
local message-body persistence. A party that obtains the owner's complete
Ambassador state, including the wrapping key for the DPoP credential, can also
decrypt the pending actions. The design protects individual files and avoids
plaintext SQLite content; it does not claim protection from complete account
or machine compromise.

Central submission and local deletion cannot be one transaction. If central
accepts a result but its response is lost, or if deletion fails after a valid
success response, the inbox may retain a stale record. Ambassador must not
guess, retry a non-idempotent submission, or delete after an uncertain result.
Central idempotency or outcome lookup is tracked as a follow-up.

## Approval

The user approved implementing the unanswered-action list with encrypted local
persistence and no new central API on 2026-09-03.

ADR 0052 later replaced the separate list tool with the unified `get_inbox`
view. The encrypted storage and removal after a successful result submission
remain current.
