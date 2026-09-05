# 0061 Durable workflows and client-specific delivery

Status: accepted

Date: 2026-09-05

## Problem

The supplied sessions show an owner question stranded in an ACP transcript and
a received action result reduced to a status summary. The receiver also waits
for ACP delivery before polling again. An ACP turn waiting in an MCP tool can
therefore prevent its own answer from arriving. An acknowledged notification,
finished model turn, completed action, and client receipt are different facts.

## Decision

One independent central receiver captures validated messages durably before
dispatch. A bounded worker processes captured events and schedules provider
delivery separately. Provider failure or a human wait cannot stop reception.
There is no competing approval poller or central poll per foreground waiter.
All handoffs have persisted identifiers and repeatable local processing.
Never repeat an external mutation or provider prompt whose outcome is uncertain.

Extend encrypted custody to permission outcomes and human-input responses.
Keep quotas, indexed bounded reads, identity binding, and credential exclusion.
Persist prepared delivery before dispatch; record dispatch before invoking a
provider. Restart may resume prepared work, never dispatched or uncertain work.
Central acknowledgement follows durable local custody and is distinct from
provider execution and client receipt. Ambiguous acknowledgements remain
uncertain because central acknowledgement is not idempotent.

ADR 0060's typed `message_box` replaces separate business tools. Add explicit
owner questions and answers. Keep enrollment, catalog discovery, and current
permission listing immediate. Every mutation has a caller request UUID and an
exact input fingerprint persisted before submission. Checks reuse that UUID.
Results survive reads and disconnects until explicit client receipt. This
receipt means client acceptance, never proof that a human read the answer.

Keep delivered conversation messages short. Load shared workflow instructions
through MCP initialization and retain only a fixed untrusted-data warning,
the relevant message-type cue, and the complete message JSON in each provider
prompt. Format the JSON with two-space indentation in a fenced `json` block.
Serialized string newlines remain escaped so remote content cannot close the
fence. Do not interpolate remote text into trusted instructions. Unknown
types direct the agent to inspect pending work, never infer an action. Keep
call correlation, permission-grant boundaries and actual-result delivery in
the relevant cues so they remain present on resumed sessions.
An owner approval permits the pending execution; it does not replace the
requested data. Scheduling guidance requires actual availability before a
proposed or created meeting. Result-shape enforcement depends on central's
future action result schemas; do not invent a local action-name mapping.

The initial request waits up to 600 seconds for a related event. Each subsequent
user-driven check can wait another 600 seconds. Return a precise continuation
on timeout; never schedule a delayed action or submit again. Support an explicit
shorter wait for constrained clients, and configure qualified provider clients
above the full 600-second business deadline. Waits have separate capacity from
ordinary tool execution. Disconnect and shutdown cancel waits, not accepted work.

Use Streamable HTTP SSE for supported progress and events during an open call.
The real Claude desktop test exposed a five-minute idle timeout despite SSE
comments. When a held workflow request supplies an MCP progress token, send
request-correlated progress at the keepalive interval. Report elapsed waiting,
without implying permission or execution has advanced. Stop on completion,
cancellation or transport failure. Clients without a progress token still need
a per-server timeout above the full wait.
Forward POST streams without buffering the entire response. Use the installed
SDK's supported protocol handling, including the current stateless revision
where qualified. Business state never depends on an MCP session ID. Optional
Tasks and elicitation expose the same durable operations only where the client
implements the required semantics. A notification does not itself start a model
turn or prove presentation in the originating chat.

Retain one enrollment and one incoming direct or webhook execution profile.
A provider extension may separately retain a verified original-conversation
return route in its own ID-only journal, keyed by the outgoing operation UUID.
OpenClaw routes persist in provider state; a Claude channel route lasts for
that stdio process. Route journals cap at 10,000 records and 32 observers. Native bridges obtain that route from provider context, not model
arguments. Qualified OpenClaw and future Hermes bridges are opt-in extensions, use fixed
reviewed APIs, and do not inspect provider credentials or edit provider history.
For verified push routes return acceptance promptly and deliver subsequent
events to that conversation. If the route disappears, retain the result in the
inbox. Deduplicate presentation events and distinguish accepted from displayed.

Owner questions are tied to the pending call and triggering message ID. Store
the question, expected input, and response correlation before asking. Use a
qualified foreground input UI or native bridge when available; otherwise use
central's existing `get_human_input` text or button operation. A human answer
resumes only the matching pending action. A background turn can return after
recording a question. Do not parse free-form model text into workflow commands.
Provider-tool permission remains a separate open ACP request with exact provider
labels and option IDs, including rejection of unrepresentable menus. Stale
answers cannot approve a different tool invocation.

Foreground owner answers use the same durable continuation as email answers.
Persist the answer before its local queue handoff and recover incomplete
handoffs in bounded batches. A local continuation has its own deduplication ID
and receives no central acknowledgement. ACP permission requests during that
turn reference the original central action notification. The desktop follow-up
on 2026-09-05 exposed and tested this previously missing implementation path.

Use exact catalog action names for permission and dispatch. Unknown names fail
before central can create a new type. Local validation must follow the published
schema and must not silently coerce payloads, insert defaults, or translate names.
Check current enrollment and grant direction; central remains authoritative for
expiry and remaining uses. Replace the draft's restricted schema conversion
with standards-based validation using existing dependencies.

ADR 0059's rotating development request/response logs remain approved, including
personal bodies after credential redaction. Include operation, call, message,
request and provider identifiers, waiting reason, state transitions, transport
closure, and timing. Logs survive clean, have bounded retention, and are never
used for recovery. The user explicitly approved keeping detailed logs for this
development release on 2026-09-05, as recorded in ADR 0059.

## Support and qualification

| Client | Target experience | Required evidence |
| --- | --- | --- |
| OpenClaw | Original-session bridge, long-poll fallback | Observed origin context, exact route, no duplicate turn, disconnected route, full wait |
| Hermes CLI and gateway | Original-session bridge, long-poll fallback | Correct existing session, opt-in permission, queued delivery without unwanted interruption, full wait |
| Codex local clients | Foreground wait and durable checks | Timeout above 600 seconds, exact result in initiating chat, reconnect; no generic idle-chat push claim |
| Claude Code | Foreground wait and qualified input UI | Full wait, form values, continuation; custom channels remain an opt-in experimental qualification |
| Claude Desktop | Separate qualification candidate | Registration/executor relationship, connection, wait, input UI and returned data; no inherited Claude Code claim |

Version metadata remains diagnostic; record tested client, provider, operating
system, configuration and protocol independently. A mock or successful HTTP
response does not qualify real user presentation. Unsupported capabilities
return a documented fallback instead of pretending to work.

The July 2026 MCP revision changes initialization and notification handling.
Use the SDK's reviewed protocol implementations for qualified clients rather
than adding guessed routes. Sources reviewed on 2026-09-05:

- [MCP revision](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [TypeScript SDK protocol support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code channels](https://code.claude.com/docs/en/channels-reference)
- [OpenClaw hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw gateway](https://docs.openclaw.ai/gateway/protocol)
- [Hermes plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

## API dependencies

No central API code changes. Track recoverable message custody, listener races,
enrollment recovery, submission idempotency/reconciliation and correlated remote
progress as human-readable API issues. Local durability cannot close the gap
between central consuming a message and Ambassador capturing it. Do not claim
exactly-once execution or unseen remote progress.

## Approval and implementation

The user approved the holistic proposal and requested implementation of all
parts, regression coverage for edge cases, and proper live end-to-end testing.
This amends ADRs 0037, 0038, 0039, 0052, 0055, 0056, 0059 and 0060 where their
polling, custody, tool, protocol or delivery requirements conflict. It permits
the reviewed opt-in native bridges; it does not authorize publication, arbitrary
provider commands, provider credential access, or central API code changes.

See [workflow test plan](../workflow-test-plan.md) for required coverage and
[current work](../implementation-plan.md) for actual completion status.

## Qualification refinements

The Claude channel must forward the connected Ambassador server's enrollment
and workflow instructions before adding its channel-specific return behavior.
Forwarding only tools left a real client looking for unrelated peer sessions.

A required action reason may use the user's stated purpose or neutrally restate
the requested action. Ask only when the schema requires a more specific purpose
that the user has not supplied. This applies to payload reasons as well as the
optional permission reason. Do not add a purpose the user never gave.
