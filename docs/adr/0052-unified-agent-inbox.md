# 0052 Unified agent inbox

Status: accepted; permission projection superseded by ADR 0054; safe paging and
outbound status amended by ADR 0056

Date: 2026-09-04

## Problem

Ambassador exposed three tools for closely related questions: pending
permission decisions, unanswered action calls, and returned action results.
Users had to know which list to request, and agents sometimes checked the wrong
direction of an action exchange.

## Decision

- Replace the former three list tools with `get_inbox`; retain no aliases.
- Accept optional `limit` and `cursor` under ADR 0056. Return complete call,
  result, then outbound-intent items in bounded pages with `next_cursor`.
- Include a `response` object on each action call naming `submit_action_result`
  and its required fields. Keep the call until central accepts that result.
- Keep calls, results, and outbound intents in separate encrypted stores.
  Validate and serialize the complete page before consuming exactly its read
  results. Denied intents remain until a later explicit permission request
  replaces them. Failed reads do not consume results.
- Permission decisions stay in ADR 0054's human email flow, never in this view.
- Uncertain outbound intents remain visible. Repeated identical requests report
  their state and do not replay an uncertain external operation.
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
