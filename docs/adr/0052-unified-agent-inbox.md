# 0052 Unified agent inbox

Status: accepted; permission projection superseded by ADR 0054

Date: 2026-09-04

## Problem

Ambassador exposed three tools for closely related questions: pending
permission decisions, unanswered action calls, and returned action results.
Users had to know which list to request, and agents sometimes checked the wrong
direction of an action exchange.

## Decision

- Replace `list_pending_permission_requests`, `list_pending_action_calls`, and
  `list_action_results` with the zero-argument `get_inbox` tool. Do not retain
  the old names as aliases.
- Return pending permission decisions first, unanswered action calls second,
  and unread action results last.
- Include a `response` object on each permission and action-call item. It names
  the response tool and the fields that tool requires.
- Keep permission items until `respond_to_permission` succeeds. Keep action
  calls until `submit_action_result` succeeds.
- Remove received action results from the encrypted local store after
  `get_inbox` returns them. A result therefore appears in one successful inbox
  response. Results remain encrypted across restarts before that response.
- Keep permission decisions as a live projection of central state. Keep action
  calls and action results in their existing separate encrypted stores. The
  unified inbox is an agent-facing view, not a third database.
- Do not copy action-specific result schemas into Ambassador. Central currently
  accepts a structured result object but publishes only the caller's
  `input_schema`. Track a central result-schema addition separately.

## Consequences

The user can ask "check my Embassys inbox" without knowing the permission and
action tool split. Work that still needs a response remains visible. Completed
results do not repeat after the agent retrieves them.

MCP has no acknowledgement that proves the human saw the rendered assistant
message. For this version, "read" means Ambassador successfully returned the
result in an MCP tool response. A transport failure after local consumption
could hide that result from a later inbox call. Central result lookup and
redelivery remain server follow-ups.

## Approval

The user approved one agent-facing inbox and removal of read results on
2026-09-04.
