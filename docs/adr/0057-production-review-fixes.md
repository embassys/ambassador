# 0057 Production review fixes

Status: accepted

Date: 2026-09-05

## Decision

Correct the production review findings in Ambassador. Keep server changes in
API issues, as requested by the user.

- Direct and OpenClaw webhook prompts use the same saved-intent policy. A
  permission outcome supplies status, never a payload to invent or submit.
- Reclaim idle MCP sessions and reclaim the oldest inactive session at capacity.
  Preserve active requests, tool calls, and streams. Expired session IDs return
  404 and require initialization again. Keep the 32-session limit.
- Send the ACP agent's actual option names as human-input button labels and
  its option IDs as values, in the original order. Return the selected ID to
  the pending ACP request unchanged. Do not translate through allow/deny or
  select an option by kind. Reject duplicate IDs, empty options, or options
  that exceed the deployed API's ten-button and 64-character limits before
  emailing. Keep the existing question detail and correlation checks.
- Load a structurally valid expired credential for local inbox and session
  access. Expiry prevents protected requests and pauses delivery with an
  explicit operator message. It does not discard the identity or its key.
- Bound ACP session close by the remaining outer deadline and the session
  stage deadline, then perform bounded cleanup. Preserve completed and
  uncertain dispatch records without replay.
- Distinguish confirmed rejection from uncertain outbound submission. Reviewed
  pre-acceptance HTTP errors may produce a rejected intent that a later
  explicit request can replace. Lost responses and ambiguous failures retain
  uncertainty. Store only bounded status metadata with the encrypted intent.
- Verbose diagnostics observe bounded response consumption and never read a
  complete diagnostic clone. Truncated or invalid bodies produce a marker,
  with no raw prefix that could reveal a credential.

## Server dependencies

Message custody and matching batch bounds are tracked in
[API issue 1](https://github.com/embassys/agent2agent/issues/1). Token renewal and
same-identity recovery are tracked in
[API issue 2](https://github.com/embassys/agent2agent/issues/2). Listener lifecycle
and bounded polling are tracked in
[API issue 3](https://github.com/embassys/agent2agent/issues/3).

Ambassador uses the existing REST contract. These issues do not add renewal,
lease, retrieval, idempotency, or fallback routes to the client. The production
limitations remain until central implements and qualifies an agreed contract.

## Approval

The user approved fixes 1 through 9 from the production review, asked for a
human-readable API issue for finding 4, and specified passing the provider's
actual choices through the human-input API for finding 3. The user then
confirmed that all API changes should be recorded as issues instead of code.
This amends ADR 0055's approval mapping and ADR 0056's outbound rejection
handling. No CLI or dependency change is included.
