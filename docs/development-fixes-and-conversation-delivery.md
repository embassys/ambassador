# Development fixes and conversation delivery

Date: 2026-09-05

Status: historical request capture. The approved design is [ADR 0061](adr/0061-durable-workflows-and-client-delivery.md); see [current work](implementation-plan.md) for implementation and qualification.

Original proposal: The design below is a
proposal, not a claim that long waits or original-conversation delivery work
today. Record changes to the accepted architecture in ADRs before implementing
them, then update the protocol and qualification evidence with the code.

## Requests captured

The user approved the first four follow-up fixes after the calendar-permission
and local-reset investigation. They then requested four additions during voice.
The later logging clarification explicitly allows request and response bodies
during development, including when `start` runs without `--verbose`.

| Work | Requested outcome |
| --- | --- |
| Exact permission matching | Request permission for the exact action that will be called. Preserve the exact payload as outbound intent when the user wants execution after approval. |
| Useful rejection details | Explain missing, pending, denied, expired, or spent permission when the server supplies a recognized reason. Keep uncertain submission distinct from confirmed rejection. |
| Identity after reset | Check permissions for the current enrolled identity. Do not claim that grants from a deleted and recreated identity still authorize it. |
| Accurate user guidance | Explain how to answer pending actions through the agent, remove references to a nonexistent Ambassador UI, and explain that `clean` removes enrollment while restarting preserves it. |
| Wait in the initiating chat | Design a tool call that waits up to ten minutes for a related approval, input request, status change, or result. A user response can lead to another call and wait. |
| Check after timeout | Return pending status and tell the user they can ask again. Each follow-up holds a new request open for another ten minutes for the same operation. Never resend the original action merely because a wait timed out. |
| Unified interaction | Use one typed local MCP interface for business submissions, responses, and waiting. Document the message types and long-poll behavior before implementation. |
| Original OpenClaw and Hermes conversation | Investigate native delivery into the conversation where the user started the request. Implement it where the provider supports a verifiable route. |
| Persistent development diagnostics | Record events, request and response bodies, timestamps, durations, and correlation IDs without requiring verbose mode. Make the files easy to locate or export. |
| Prevent contract mistakes | Explain the permission/action mismatch and add a repeatable process that catches similar errors before release. |

Central API code changes remain out of scope. File clear, human-readable issues
in `embassys/agent2agent` for server work. Existing approval choices must continue
to use the provider's exact option labels and IDs without mapping their meaning.
The confirmed stop-and-proceed behavior for `start` and `clean` remains required.

ADR 0057's production-review fixes and ADR 0058's process confirmation are
already implemented locally and unpublished. This document records the next
work; it does not reopen those completed changes.

## Permission mismatch and immediate fixes

Ambassador exposes `list_action_types`; the action catalog is not missing from
the local tool interface. Central resolves a permission name to an action-type
ID and checks the exact grantor, grantee, and action-type ID when accepting an
action. `permission_type` is an alternate field name for `action_type`, not a
separate category of permission. The reviewed contract has no rule that expands
`read_calendar_permission` to cover `read_calendar_event_by_title`.
See the [reviewed central permission check](https://github.com/embassys/agent2agent/blob/708f205bfaee5010eb86fcfae55967fb5d02071c/main.py#L1595-L1651).
The repository's main revision was rechecked for this plan.

The agent's broad-calendar authorization claim was wrong. Ambassador's guidance
and qualification did not prevent that assumption. The supplied failure also
occurred before the local cleanup, so the reset cannot explain that original
403. The later recreated identity is a separate reason to check permissions
again. This permission rejection occurs before target delivery and does not
show whether the target has connected a calendar provider.

Implement these changes after recording the decisions:

1. Make action catalog descriptions, permission requests, delivery instructions,
   and examples explicit about exact matching. Select an action once and carry
   that same name through the permission request and saved outbound dispatch.
   Validate intended payloads against the selected catalog entry. Do not invent
   category mappings from names or descriptions.
2. Parse bounded central error bodies and map only reviewed rejection reasons
   into useful local errors. Preserve safe status and correlation metadata.
   Unknown responses retain a generic error and their uncertainty classification.
3. Bind operation state and permission observations to the current enrollment.
   Check current central permissions when diagnosing authorization. A local
   preflight is advisory because central remains authoritative for expiry and
   concurrent spending of a one-use permission. Do not infer an unspent grant
   from `status: granted`; the current permission list omits the use budget.
4. Update tool guidance and operator documentation for pending user answers,
   clean versus restart, and identity loss. Central identity recovery remains
   [API issue 2](https://github.com/embassys/agent2agent/issues/2).

## Proposed message box and long-poll design

Put the unified interface at Ambassador's local MCP boundary. Keep the current
central REST operations underneath it. A ten-minute local wait can observe
multiple bounded central polls; it does not require a ten-minute REST request.

The user's clarification selects actual long polling. The initial tool call
submits once and stays open for up to ten minutes waiting for a related update.
It must not immediately return a pending receipt and require a separate wait
call. When no update arrives, the response tells the user they can ask again.
That follow-up makes a new long poll for the same operation, again for up to ten
minutes. Repeat this cycle while the user wants to check. This replaces the
earlier fixed thirty-minute retry suggestion; no timer or automatic scheduled
call is implied.

Recommend one MCP tool named `message_box`. A required `type` selects a strict
message schema and its handler. The initial business message types are:

| Type | Effect |
| --- | --- |
| `request_action` | Save the exact action and payload, request its matching permission, dispatch once after a matching grant, and wait for a related update. |
| `request_permission` | Request permission alone and wait for its outcome. A grant creates no action payload. |
| `submit_action_result` | Submit the user's supported answer to a pending action by its `call_id`. Return immediately if this completes the caller's work; otherwise wait for a defined related update. |
| `check` | Return an already available related update, or hold the call open for up to ten minutes. Never repeat a submission. |

Keep setup, enrollment, and immediate catalog or status reads outside the
long-poll lifecycle. This is a typed business-message interface with existing
permissions, not an arbitrary chat relay. Reject unknown types and fields. When
adopting it, replace the superseded business tools rather than retaining two
competing ways to submit the same work.

An initial submission includes a caller-generated `request_id` so the agent can
recover even if it disconnects before receiving the first response. Persist
that ID and the operation before any external side effect. Scope it to the
enrollment and bind it to the exact typed input. A repeated identical request
joins or resumes observation of the same operation. Reusing its ID for changed
input is an error. A request with an uncertain central outcome must never be
automatically submitted again. These are local deduplication guarantees; they
do not create central idempotency or resolve a lost central response.

Responses include an Ambassador operation ID and the available central
permission, call, or message IDs. `check` accepts the known request or operation
reference plus a continuation cursor. Bind references to the enrollment and
originating local conversation when that conversation is known. The model must
not reconstruct a mutation from the last notification.

A response reports a related event and current state. The useful event types
are permission status, input needed, action submitted, action result, rejection,
and uncertainty. A notification that input is needed must identify the actual
response channel. Embassys permission decisions stay in email. ACP approval
continues through `get_human_input` with the provider's exact choices. Do not
invent a local permission-decision endpoint.

Return as soon as a relevant update is available, or when the 600-second
deadline expires. Count submission time within that request's deadline. Normal
acceptance or queue receipts alone do not end the initial wait. A permission
decision, a real input request, a result, a definitive rejection, or uncertainty
that requires attention can end it. Immediate validation failures also return
without waiting. A completed operation returns its terminal state immediately.

On timeout, return `status: pending`, `reason: wait_timeout`, the request and
operation references, the cursor, and instructions such as: "No update yet.
Ask me to check this request again when you are ready." Supply the exact
`message_box` continuation with `type: check` in structured data, so the agent
does not have to invent its next call. If an update arrives between polls,
the next check returns it immediately. Timeouts must not discard updates.

After the user answers through a supported message type, a further wait follows
the same rule when there is still a related outcome to observe. Permission
grants and action dispatch remain separate states. Do not hold a completed
response open for ten minutes when there is no outstanding related work.

The prototype must resolve these constraints before adoption:

- Ambassador currently limits MCP requests to 35 seconds. Qualify the real
  client timeout and cancellation behavior before claiming a ten-minute wait.
  Raise the local handler and transport deadlines for these waits while keeping
  parsing, ordinary reads, and central HTTP calls bounded separately. A progress
  notification alone does not prove the client will keep it open. The
  [MCP timeout contract](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts)
  leaves timeout enforcement with the requesting client and recommends a finite
  maximum even when progress extends an idle timeout.
- One gateway polling owner must distribute related events to waiters and
  delivery. A waiter must not become a competing central message consumer or
  take an ACP approval response away from its pending request.
- Waiting must not occupy every ordinary tool slot. Bound waiters separately,
  release them on disconnect and shutdown, and keep submissions responsive.
- Deliver each message through one chosen execution path. Observing a grant
  must not cause both the original chat and ACP to submit the saved action.
- A timeout, disconnect, or cancellation ends observation. It does not establish
  that an accepted action was cancelled or is safe to retry.
- Define cursor retention and result acknowledgement before changing inbox
  consumption. The existing read-once inbox does not by itself guarantee that
  a disconnected waiter can retrieve the same result again.
  A cursor advances only for updates acknowledged by a subsequent request or
  an explicit receipt message. Reserve retention for unacknowledged updates
  within a documented quota; report capacity limits instead of silently losing
  a result between long polls.
- Keep resumable state bounded. Use existing encrypted action stores where
  possible. Any new durable event content needs an explicit storage decision.
  Diagnostic logs must never become a source for replaying actions.

Central consuming-poll loss and uncertain submissions remain real limits.
[API issue 1](https://github.com/embassys/agent2agent/issues/1) tracks recoverable
message custody. Record any additional server dependency as an issue rather
than adding a speculative client route.

## Delivery to the original provider conversation

The target is the conversation that initiated this operation, including its
account and thread where applicable. The provider's default `main` agent is not
sufficient routing information. Current Ambassador direct delivery uses a
separate ACP session, and its OpenClaw webhook uses an isolated turn.

OpenClaw documents hook session selection and delivery controls. Its plugin
hooks can expose session context. These are candidates to investigate, not
evidence that the current Ambassador MCP connection identifies the original
desktop chat. Review the [native webhook configuration](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md)
and [plugin context](https://docs.openclaw.ai/plugins/hooks), then verify the
installed provider's implementation and UI behavior.

Hermes documents `ctx.inject_message` for an active CLI conversation or a known
gateway session. That establishes a native integration candidate, but does not
prove that every desktop client exposes it or that Ambassador knows the right
session. Injection during an active CLI turn can interrupt that turn. Review
the [Hermes injection contract](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins#injecting-messages)
and qualify idle and active conversations separately.

For each provider, prove how a provider-owned conversation ID reaches Ambassador
with the initiating tool call, how replies target that exact conversation, and
what happens when it closes. Do not route by a remote message's claimed session
ID or guess the most recent chat. Test two concurrent conversations to catch
cross-routing and duplicate delivery. Preserve the untrusted-message envelope.

Implement a supported route after documenting its fixed profile, setup,
correlation, and qualification. If it requires a provider extension, document
that integration and its installation implications first. Record unsupported
clients explicitly; the wait design still offers a path back to the initiating
chat without claiming universal native push support.

## Development diagnostics

Implement a persistent diagnostic sink for foreground runs. `--verbose` should
control console detail; it should not decide whether development evidence is
recorded. Include startup and shutdown, MCP calls, central requests and
responses, polling and dispatch, provider lifecycle and approvals, webhook
delivery, acknowledgements, errors, and timeout or cancellation events.

Each structured record should contain a UTC timestamp, event name, process/run
ID, relevant request/operation/message IDs, duration and status when available,
and bounded request or response content. Record recognized error bodies too,
so a 403 can be diagnosed after the event. Mark omitted or oversized data.
Retain the existing credential interception and redact tokens, verification
codes, private keys, proofs, nonces, cookies, and secrets before writing.

Use an owner-only log directory, bounded files, rotation, and bounded buffering.
Do not collect provider configuration, credentials, or unrelated chat history.
Log only events and content that Ambassador handles. A failed diagnostic write
must be visible to the operator and must not repeat an external operation.

Print the exact log location at startup and document how to copy the files.
The user accepts a known file location instead of an export command, so prefer
that simpler first implementation. Ensure logs remain available to investigate
a `clean` reset, with their own retention limit. Define the temporary body
retention policy in an ADR, and resolve the production logging policy before
publishing these development changes.

## Preventing future contract mismatches

Keep a short contract evidence table linking each Ambassador operation to the
reviewed server handler, schema, fixture cases, and controlled live check.
Record the reviewed source revision and qualification date. Source review and
OpenAPI review are both needed because authorization semantics are not fully
described by request schemas.

Add regression cases before implementation for different action names,
reversed grantor and grantee, changed enrollment, pending or denied permission,
expiry, a spent one-use grant, and unrelated outcomes. Cover direct calls and
saved-intent dispatch. Include a test where a broad-sounding calendar name is
granted but the requested event-search action is rejected. An exact matching
grant must succeed without any local name mapping.

Qualification should exercise this against controlled identities and the
deployed catalog. Never use a fixture pass or a catalog description as proof of
live authorization semantics. If the API later introduces category grants,
adopt only an explicit published relationship after source review and live
qualification. Ambiguous catalog entries or missing status fields belong in
human-readable API issues.

## Implementation order and completion evidence

1. Record this plan and the necessary ADRs before code.
2. Add regression coverage and implement the four immediate fixes plus
   persistent development diagnostics.
3. Qualify provider conversation correlation and ten-minute MCP waits. Use
   those results to finish the public interaction and routing decisions.
4. Implement the supported original-conversation delivery paths. Implement the
   wait design only after its contract and delivery ownership are settled.
5. Run the relevant deterministic tests and controlled live qualifications,
   update setup guidance and evidence, and remove completed work from the open
   implementation plan. Report provider limitations and remaining API issues.

There is no unanswered user preference at this stage. Body logging during
development is approved. Provider capability and client wait limits require
investigation, not another speculative permission question. This plan does not
authorize publication or central API code changes.
