# 0051 Encrypted received-action-result inbox

Status: accepted; retrieval amended by ADR 0052; capacity and safe paging by ADR 0056

Date: 2026-09-04

## Problem

Central sends an `action_response` to the identity that requested an action.
In direct mode, Ambassador delivered that response to a new background ACP
session. The session could read the result, but the foreground MCP chat that
made the request could not retrieve it. Ambassador then acknowledged the
central message, so asking "have we heard back?" in the foreground chat
returned no useful answer.

`list_pending_action_calls` cannot solve this. It lists calls this identity
received and still owes to another agent. It does not list responses to calls
this identity made.

MCP tool calls do not carry a portable provider conversation ID. MCP also has
no standard operation that lets a server inject a new assistant message into
an arbitrary Claude, Codex, Hermes, or OpenClaw chat. Asking the model to send
a provider session ID would create a spoofable provider-specific field without
creating the missing push channel.

## Decision

- Expose each result's `call_id`, sender agent ID, action type, status,
  structured result, and creation time through an agent-facing inbox.
- At receipt from either polling path, before local delivery or acknowledgement,
  validate and store every
  `action_response` in a separate encrypted SQLite inbox.
- Encrypt each row with AES-256-GCM. Derive separate encryption and HMAC lookup
  keys from the enrolled DPoP private key and thumbprint. The plaintext call ID
  and returned data do not enter SQLite.
- Key records by the HMAC of `call_id`. An exact duplicate is idempotent and a
  conflicting duplicate fails closed.
- Bound each record to 512 KiB and the store to 1 GiB of ciphertext. Use
  bounded keyset pages; validate and serialize a page before consuming only its
  returned results. Records remain
  available across restarts until the inbox returns them or the owner runs
  `ambassador clean`.
- Do not accept a foreground chat or session ID in MCP input. Do not attempt a
  provider-specific push into the chat that made the original call.
- Keep delivering the complete central message through the configured direct
  or webhook mode. The local result copy does not replace webhook custody or
  ACP session history.
- In verbose mode, replace an ACP available-command catalog with one event that
  contains only the session ID and command count.

## Consequences

A user can ask whether an Embassys action returned in any later MCP chat. The
answer survives an Ambassador restart and does not depend on finding the
background ACP session.

This is not a central outcome lookup. Ambassador can expose only responses it
captured from central. A crash after central consumes a message but before
local capture can still lose the result because central has no retrieval or
redelivery route.

The result database is separate from the pending-action database, keeping the
two directions and their quotas independent. A complete local-state compromise can decrypt both inboxes because both
derive keys from the enrolled credential.

## Approval

The user approved local result persistence, later MCP retrieval, and removal
of ACP available-command details from verbose output on 2026-09-04.

ADR 0052 later combined permission requests, action calls, and unread action
results in `get_inbox`. It also made returned results consumable after one
inbox response.
