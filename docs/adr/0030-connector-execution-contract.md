# 0030 Connector execution contract

Status: accepted

Date: 2026-08-30

Approval: approved by the user on 2026-08-30

This accepted record completes its part of D05. ADR 0032 permits K01 against
the accepted G04 fixture contract. Provider interfaces, installation, and
publication retain their later gates.

## Problem

ADR 0024 accepts a provider-neutral connector boundary, but it deliberately
leaves the common provider port, execution limits, local policy, and uncertain
turn behavior to D05. Without one exact contract, adapters can disagree about
when a provider turn starts, which failures are safe to report as definite,
how much output they may retain, and when the connector may acknowledge an A2A
message.

Those differences are dangerous. A connector that retries an uncertain turn
can repeat file changes or external calls. An unbounded event stream can
exhaust local memory. A connector that acknowledges before central accepts a
reply can lose the response. The common contract must close those gaps before
provider-specific tests or code begin.

## Proposed decision

Adopt one language-neutral internal provider port with four operations:
`start`, `resume`, `recover`, and `cancel`. The first three produce a bounded,
pull-based event stream. `cancel` controls one active stream. The connector owns
scheduling, durable opaque state, gateway MCP calls, central outcome resolution,
and acknowledgement. An adapter owns only translation between this port and
one separately approved provider interface.

Within connector custody, all A2A text, provider output, approval detail,
stdout, stderr, and final reply text remains in bounded process memory. None of
it enters connector state, gateway state, logs, diagnostics, metrics, temporary
files, crash artifacts, or support bundles. A separately approved provider may
retain its own native history as disclosed under ADR 0024; the connector never
copies that history.

This ADR completes N3-D4 and N3-D5 only for the common execution contract.
It does not choose the connector executable or CLI, state implementation,
runtime, library, provider transport, provider executable or SDK, package,
supported platform, installation method, or publishing path. ADRs 0028, 0029,
and 0031 fix the remaining D05 choices; provider-specific choices retain their
later ADRs.

## Work scheduling

The connector uses these fixed limits:

| Resource | Proposed limit |
| --- | --- |
| Active A2A turns per conversation | 1 |
| Active A2A turns across the connector | 2 |
| Waiting wake entries | 100 opaque message IDs |
| Accepted webhook TCP sockets | 32 |
| Parsed webhook requests | 16 |
| Webhook request line | 2,048 octets, excluding its terminating CRLF |
| Webhook header block | 16,384 octets, from the first header through the terminating empty line |
| Webhook header deadline | 2 seconds from TCP acceptance |
| Webhook request and response deadline | 5 seconds from TCP acceptance |
| One local gateway MCP request | 35 seconds under ADR 0012 |
| One logical provider turn | 15 minutes from its first durable dispatch decision |
| Grace after a cancellation request | 10 seconds |
| Forced containment cleanup | 3 seconds after the cancellation grace |
| Provider root processes per active turn | 1 |
| Normalized events per provider-port invocation | 10,000 |
| Captured stdout per provider turn | 8 MiB |
| Captured stderr per provider turn | 8 MiB |
| Final reply text | 262,144 UTF-8 bytes |

An active A2A turn starts when the connector removes a message from the
waiting queue. It ends only after central has accepted a reply or terminal
completion and has returned the exact `acked` result. Waiting for approval,
resolving an uncertain central response, and retaining a reply after
`mailbox_full` all keep that conversation lane and one of the two global turn
slots occupied. This bounds raw message and reply retention to two active
turns.

The one durable dispatch decision is the atomic message transition from
`received` to `binding` for `start`, or from `received` to `turn_starting` for
`resume`. That transaction stores `turn_started_at_ms=now` and
`turn_deadline_ms=now+900000`. `now` must be a nonnegative whole Unix epoch
millisecond value no greater than `253402299899999`, so the deadline is no
greater than `253402300799999`. The connector commits that transition before
calling the port. A committed `binding` or `turn_starting` row means dispatch
may have happened. It never authorizes another `start` or `resume`, even when a
later observation proves that the port call did not begin.

The connector passes the stored deadline to the first port call as
`deadline_unix_ms`. A restart, repeated wake, `recover`, approval wait, or
cancellation never changes it. A recovered invocation receives the same value.
For each invocation, the connector arms a monotonic timer for
`max(0, turn_deadline_ms - validated_wall_clock_now)` rather than another
15-minute interval.

On startup, the connector compares the current wall clock with every durable
row's `updated_at_ms`, as ADR 0029 requires. If the clock is earlier than any
such value, startup stops before webhook acceptance, gateway access, or
provider work with `connector_state_unavailable`. If the provider deadline has
passed, the connector submits no input. With an exact recoverable turn it may
invoke only `recover`, then request cancellation using the remaining absolute
grace described below. Without an exact recoverable turn, it follows the
uncertainty rules. Once the connector has accepted an exact terminal provider
event, central outcome resolution and acknowledgement do not consume or extend
provider execution time.

The waiting queue is memory-only and contains at most 100 distinct opaque A2A
message IDs. A repeated wake for a queued or active message does not consume
another entry. If a valid wake would add entry 101, the connector returns a
fixed retryable failure and retains no queue entry or body. Its authenticated
replay-cache entry may remain until normal expiry. The gateway remains
responsible for redelivery. The connector never evicts an older entry to admit
a newer one.

The connector retrieves content only when a global turn slot is available. It
calls the gateway's local `poll_messages` tool with exactly `{"timeout":0}`.
It validates the complete bounded result before using any message and requires
every returned version 2 message to have one valid ID. If the admitted ID
appears, it must appear exactly once. The connector selects that message and
immediately discards every returned body; other already queued IDs remain in
the queue. If the admitted ID is absent, it discards all returned bodies,
removes that one queue entry, creates no durable message row, and starts no
provider or delivery-control work. Gateway redelivery may admit the ID again.
A malformed result, an ID-less version 2 message, or a duplicate admitted ID is
a gateway contract failure. The connector never copies a local MCP result into
the queue or durable state.

### Conversation lifecycle

The durable conversation lifecycle has exactly four states:

- `binding` is the unbound first-conversation lane. Its message state carries
  the dispatch fact: message `received` means no dispatch decision exists,
  while message `binding` means the first `start` decision is durable and the
  provider may have received it. Only message `received` permits that one
  initial dispatch after gateway redelivery.
- `active` has one exact provider-session mapping and may accept the next
  linear turn through `resume`.
- `uncertain` means the connector cannot prove the exact provider session,
  turn, containment, or outcome. It permits only exact recovery or safe central
  completion of the already active message. It never permits `start` or
  `resume` for that conversation.
- `closed` follows any accepted ADR 0025 no-reply completion, including an
  uncertain completion. It permits no later provider call.

An accepted reply keeps the conversation `active`. After central accepts a
no-reply completion and before acknowledgement, the connector durably marks the
conversation `closed`. A provider that definitely reports a valid durable
mapped session as missing or unusable never causes a fresh session. If no
provider call began, the connector plans `failed/provider_start_failed`; the
conversation closes only after central accepts that completion. If a call may
have begun, it recovers the exact turn or records
`uncertain/provider_outcome_unknown`.

A missing, malformed, or unauthenticated session envelope in connector state
is state corruption under ADR 0029, not a provider failure. The connector makes
no central terminal call and stops before provider dispatch.

A later message for a `closed` conversation, or a different message behind an
`uncertain` conversation, is a central or local correlation contract failure.
The connector performs no provider call, reply, completion, or acknowledgement
for that later message. It leaves the message open and stops with the fixed
content-free error `connector_conversation_unavailable`. A repeated wake for
the one active uncertain message may drive only its approved recovery path.
If exact recovery later produces the original valid reply, reply acceptance and
acknowledgement return that conversation to `active`. Any accepted no-reply
completion moves it to `closed`; no other transition leaves `uncertain`.

ADR 0029 represents the same absolute provider deadline in its
`turn_deadline_ms` column, all four conversation states, the message-wide
saturating central attempt count, the pending operation kind, and the absolute
next-attempt time. Its transition table also contains the pre-binding terminal
and lost-reply transitions defined below. No durable state at or after
`binding` or `turn_starting` may authorize redispatch. An amendment to this ADR
does not silently amend that schema.

## Webhook admission

The connector is the gateway's one configured literal-loopback webhook target.
ADR 0028, accepted with this record, accepts only `POST` to
`/webhook` on that ADR's exact loopback port, with no query. It accepts HTTP/1.1
only. Keep-alive and pipelining are disabled. The server processes at most one
request on a TCP connection, sends `Connection: close` on every parsed
response, and closes the connection after that response.

The connector permits at most 32 accepted TCP sockets. On socket 33 it destroys
the new socket without reading or writing application bytes. It permits at
most 16 requests whose complete header block has been parsed but whose response
has not finished. A seventeenth parsed request receives the fixed capacity
error and closes. Neither refusal allocates replay or queue state.

Both clocks start when the TCP connection is accepted. The complete request
line and header block must arrive within 2 seconds. Admission and the complete
response must finish within 5 seconds. The five-second deadline includes the
body read, HMAC, replay reservation, strict parse, queue decision, and response
write. A connection that sends no byte is closed at 2 seconds. Either deadline
destroys the socket without an HTTP response if no response byte has already
been committed. If a response has started, the connector stops writing and
destroys the socket. It never selects between a timeout response and a close
based on a token, signature, header value, or body value. Progress extends
neither deadline.

The request line is at most 2,048 octets excluding its terminating CRLF. The
header block is at most 16,384 octets from the first header byte through the
terminating empty line. Obsolete folding, a bare CR or LF, an invalid field
name, or a control character outside HTTP's permitted grammar is malformed.
Header field names use ASCII case-insensitive comparison. The connector rejects
any duplicate `Host`, `Origin`, `Authorization`, `Content-Type`,
`Content-Length`, `Idempotency-Key`, `X-Request-ID`, `X-Webhook-Timestamp`, or
`X-Webhook-Signature-V2` field across all case spellings, even when duplicate
values are identical. It rejects every `Transfer-Encoding`, `Trailer`, and
`Expect` field, plus every `Upgrade`, `TE`, and `Proxy-Connection` field, using
the same name comparison.

For each accepted single field, the parser removes only leading and trailing
HTTP optional whitespace, ASCII space or horizontal tab, before applying the
field's value grammar. Optional whitespace inside a value remains part of the
value and fails any exact grammar below. `Content-Length` must then be exactly
`0` or an ASCII digit from `1` through `9` followed by zero or more ASCII
digits. A sign, leading zero, internal whitespace, non-ASCII digit, unsafe
integer, or syntactically invalid value is invalid framing. A syntactically
valid value above 1,048,576 is instead `connector_body_too_large` and receives
HTTP `413` before any body byte is read.

For an allowed declared length, an early EOF or fewer body octets is invalid
framing. After the declared byte is read and before the connector commits a
response or queue mutation, it checks bytes already accepted into the
connection parser. That check and the queue decision run synchronously without
an intervening await. A surplus byte already present makes the request invalid
framing, and no wake is committed. Bytes that arrive only after a response or
queue decision has committed cannot revoke that decision. The connector closes
the connection without parsing those bytes and never treats them as another
request. It processes no pipelined or keep-alive request.

After those parser-level checks, the connector applies this order before a
wake can enter the queue:

1. Require the request line to contain method `POST`, exact target `/webhook`,
   and version `HTTP/1.1`.
2. Require `Host` to equal the listener's exact configured loopback authority.
   A supplied `Origin` must equal the listener's exact configured loopback
   origin. A missing `Origin` remains valid for the non-browser gateway client.
3. Require exactly `Content-Type: application/json` and exactly
   `Authorization: Bearer <token>`, with no media-type parameter, bearer
   parameter, or alternate scheme. Compare the complete token in constant time
   with the locally supplied webhook token.
4. Require `X-Webhook-Timestamp` to match exactly `0|[1-9][0-9]{0,11}` after
   optional-whitespace removal. Parse it as a safe integer and reject a value
   above `253402300799`. At validation time, it may be at most 300 seconds old
   and at most 5 seconds in the future.
5. Require one lowercase 64-hexadecimal `X-Webhook-Signature-V2`. Check the
   bounded in-memory replay cache for the timestamp and signature pair before
   reading the body. Do not reserve an unauthenticated pair yet.
6. Read exactly the declared raw body length, stopping at byte 1,048,577 under
   every framing path. Compute HMAC-SHA-256 over the ASCII timestamp, one `.`
   byte, and the exact raw body bytes, using the webhook token as the key.
   Compare the complete signature in constant time.
7. After HMAC validation, atomically reserve the timestamp and signature pair
   in the replay cache before parsing JSON. The cache holds at most 4,096 live
   pairs and removes a pair after its timestamp is more than 300 seconds old.
   If the full cache has no expired entry, reject the request without parsing
   it.
8. Parse one strict JSON object. Reject duplicate or unknown keys, invalid
   Unicode scalar values, and any body that is not the exact ID-bearing wake
   contract in `docs/protocol-v1.md`. Require `Idempotency-Key`,
   `X-Request-ID`, and the body message ID to carry the same opaque ID.
9. Coalesce a valid repeated message ID. Otherwise admit it only when the queue
   has capacity. After content retrieval, conversation scheduling enforces the
   per-conversation lane.

Host, Origin, bearer, header-size, declared-length, framing, and timestamp
checks happen before any body read. HMAC validation and replay reservation
happen before JSON parsing. No unauthenticated request allocates replay or
queue state. These deadlines finish inside ADR 0012's 10-second gateway wake
deadline.

The replay cache is memory-only. A connector restart may forget it, but a
replayed wake can only enqueue the same opaque message ID. The queue and active
turn checks still prevent a second provider turn. ADR 0029's durable execution
state remains the crash barrier.

Every parsed response uses `Content-Type: application/json`,
`Cache-Control: no-store`, `Connection: close`, and an exact decimal
`Content-Length` for its compact UTF-8 body. Errors use the exact body
`{"error":"<code>"}` and contain no reflected header, token, URL, ID,
signature, or body data:

| HTTP status | Code | Cause |
| ---: | --- | --- |
| `404` | `connector_path_not_found` | Path or query is not the accepted webhook target |
| `405` | `connector_method_not_allowed` | Method is not `POST` |
| `414` | `connector_request_line_too_large` | Request line exceeds 2,048 octets |
| `431` | `connector_headers_too_large` | Header block exceeds 16,384 octets |
| `400` | `connector_framing_invalid` | HTTP version, framing syntax, duplicate field, folding, early EOF, pre-commit surplus, keep-alive reuse, or pipelining is invalid |
| `503` | `connector_request_capacity` | Sixteen parsed requests are already active |
| `421` | `connector_host_rejected` | Host is not the exact listener authority |
| `403` | `connector_origin_rejected` | A supplied Origin is not the exact listener origin |
| `401` | `connector_auth_failed` | Bearer or HMAC authentication fails |
| `400` | `connector_timestamp_invalid` | Timestamp syntax or acceptance window fails |
| `409` | `connector_replay` | Timestamp and signature pair is already live |
| `503` | `connector_replay_capacity` | The replay cache is full after expiry cleanup |
| `413` | `connector_body_too_large` | Raw body exceeds 1 MiB |
| `400` | `connector_wake_invalid` | Content type, HMAC-authenticated JSON, header correlation, or strict wake schema is invalid |
| `503` | `connector_queue_full` | A new distinct message would exceed 100 queued IDs |

Invalid bearer and invalid HMAC deliberately share one response. A valid new
or coalesced wake returns HTTP `202` with exact body
`{"status":"accepted"}` and the same fixed response headers. No diagnostic
includes raw request data.

## Internal provider port

The port is a logical contract, not a language or transport selection. All
operation inputs and normalized events are closed records. A missing,
duplicate, or unknown field fails before provider dispatch. A provider-specific
adapter may use an SDK, stdio, a socket, or another interface only after its
own ADR accepts that choice.

### Operations

Every request is a plain closed record with the exact keys below. Optional
values are present as JSON `null`; they are never omitted. `deadline_unix_ms`
is the exact durable provider deadline, represented as a nonnegative safe
integer no greater than `253402300799999`. A missing, duplicate, unknown,
mistyped, or out-of-bound field fails before provider dispatch.

| `kind` | Exact remaining fields | Meaning |
| --- | --- | --- |
| `start` | `execution_id`, `conversation_id`, `message_id`, `input_text`, `deadline_unix_ms` | Create the first provider session and first provider turn for an unmapped A2A conversation |
| `resume` | `execution_id`, `conversation_id`, `message_id`, `provider_session_id`, `input_text`, `deadline_unix_ms` | Start the next provider turn in the exact mapped provider session |
| `recover` | `execution_id`, `conversation_id`, `message_id`, `provider_session_id`, `provider_turn_id`, `deadline_unix_ms` | Observe the exact existing provider turn without submitting input or starting work; `provider_turn_id` is either the durable exact ID or `null` |
| `cancel` | `execution_id`, `provider_session_id`, `provider_turn_id`, `reason` | Request cancellation of that invocation; each provider ID is its known exact value or `null`, and `reason` is `deadline`, `shutdown`, `output_limit`, `contract_failure`, or `state_failure` |

`execution_id` is a fresh process-local lowercase canonical UUID v4 created by
the connector before one port invocation. It is never sender-controlled and
does not replace the durable provider turn ID. `conversation_id` and
`message_id` have already passed ADR 0025 validation. `input_text` is the only
sender-controlled field and retains ADR 0025's 1-to-262,144 UTF-8-byte bound.
The adapter receives no input text in `recover` or `cancel`. The connector gets
provider session and turn IDs only from validated adapter events and
content-free state.

`recover` normally carries the durable exact turn ID. A session-only request
with `provider_turn_id: null` may return anything other than `uncertain` only
when the provider-specific ADR and tests prove a non-creating, unambiguous
lookup of the one exact prior turn. Its first event must bind that turn before
any recovered output. Otherwise the adapter emits the fixed uncertain terminal
event without starting work.

`cancel` may run concurrently with one outstanding pull from the matching
stream. It returns exactly one closed record:

```json
{"status":"cancel_requested"}
```

or the same one-field record with status `already_terminal` or `not_found`.
These statuses acknowledge only the adapter request. None proves that provider
work stopped or that no effect occurred. The remaining absolute grace starts
before the connector calls `cancel` and is never extended by a slow or failed
cancel call.

The connector constructs each adapter with sealed local execution settings.
No port call accepts a provider command, model, working directory, provider
session override, system instruction, tool list, MCP configuration, sandbox
mode, approval mode, or environment override. A sender-controlled string is
never parsed as one of those settings.

### Normalized event stream

`start`, `resume`, and `recover` return a pull-based stream. Every event is a
plain closed record and carries the request's exact `execution_id`. The event
kind fixes its complete remaining key set:

| `event` | Exact remaining fields | Terminal |
| --- | --- | --- |
| `session_bound` | `execution_id`, `provider_session_id` | No |
| `turn_bound` | `execution_id`, `provider_turn_id` | No |
| `progress` | `execution_id`, `text` | No |
| `approval_required` | `execution_id`, `approval_request_id` | No |
| `approval_resolved` | `execution_id`, `approval_request_id`, `decision` | No |
| `reply` | `execution_id`, `text` | Yes |
| `completed_without_reply` | `execution_id` | Yes |
| `unsupported` | `execution_id`, `reason_code` | Yes |
| `failed` | `execution_id`, `reason_code` | Yes |
| `cancelled` | `execution_id`, `reason_code` | Yes |
| `uncertain` | `execution_id`, `reason_code` | Yes |

`progress.text` is a Unicode scalar string from 1 through 262,144 UTF-8 bytes
and is used only in memory. Normalized events contain no provider-defined
object, arbitrary key, or arbitrary structured detail. `reply.text` has the
same string bound. `unsupported.reason_code` is
`unsupported_message_type` or `unsupported_payload`. `failed.reason_code` is
`provider_start_failed`, `provider_execution_failed`, or
`provider_result_invalid`. `cancelled.reason_code` is
`cancelled_before_execution` or `cancelled_during_safe_wait`.
`uncertain.reason_code` is exactly `provider_outcome_unknown`.
`approval_resolved.decision` is exactly `approved` or `denied`. It reports a
provider-owned decision. It does not grant approval and does not itself end the
turn.

The event automata are exact. The safe pre-turn terminal set is only
`unsupported` with either accepted unsupported reason,
`failed/provider_start_failed`, `cancelled/cancelled_before_execution`, or
`uncertain/provider_outcome_unknown`. The first three require positive adapter
evidence that provider input was not dispatched. `uncertain` needs no such
claim. Without that evidence, a claimed definite safe pre-turn terminal is a
contract failure and maps to uncertainty.

`start` begins in `start_unbound` and follows only these transitions:

| State | Event | Next state and durable action before another pull |
| --- | --- | --- |
| `start_unbound` | `session_bound` | Validate and publish the session, move the conversation `binding -> active` and message `binding -> turn_starting`, then enter `turn_unbound` |
| `start_unbound` | Safe pre-turn terminal | Publish its fixed completion directly from message `binding`; `uncertain` instead moves message and conversation to `uncertain`; end the stream |
| `turn_unbound` | Safe pre-turn terminal | Publish its fixed completion directly from `turn_starting`; `uncertain` instead moves message and conversation to `uncertain`; end the stream |
| `turn_unbound` | `turn_bound` | Validate and publish the turn, move `turn_starting -> turn_running`, then enter recoverable `running_bound` |
| `turn_unbound` | First `progress` | Atomically move `turn_starting -> turn_running` with no turn ID, accept the text, then enter unrecoverable `running_unbound` |
| `turn_unbound` | First `approval_required` | Validate the approval ID, atomically move `turn_starting -> waiting_for_approval` with no turn ID, then enter unrecoverable `waiting_unbound` |
| `turn_unbound` | `reply`, `completed_without_reply`, `failed/provider_execution_failed`, `failed/provider_result_invalid`, `cancelled/cancelled_during_safe_wait`, or `uncertain` | Atomically publish the exact central plan directly from `turn_starting` with no turn ID; end the stream |

`resume` begins in `turn_unbound` with the exact durable session mapping. It
never emits `session_bound` and otherwise uses the same `turn_unbound`
transitions. A provider with no stable per-turn ID can qualify through the
unrecoverable branch. It gives up exact crash recovery for that turn. A crash
after the dispatch marker and before a durable terminal plan remains uncertain;
it never permits redispatch.

The durable source state selects the recovery automaton. Recovery never chooses
an automaton from provider output:

| Durable source | Required handle and entry automaton |
| --- | --- |
| `turn_starting` | Exact session and null turn; enter `recover_unbound` only under the qualified non-creating session lookup |
| `turn_running` | Exact non-null turn; enter `running_bound` |
| `waiting_for_approval` | Exact non-null turn; enter `recover_waiting_bound` |
| `uncertain` | Exact non-null turn; enter `recover_terminal_only` |
| `central_pending(reply)` after exact outcome `open` and loss of reply bytes | Exact non-null turn; enter `recover_reply_only` |

No other durable source calls `recover`. In particular, durable
`running_unbound` and `waiting_unbound` have no exact turn handle and become
uncertain after a crash.

Session-only `recover_unbound` must emit `turn_bound` or
`uncertain/provider_outcome_unknown` first. `turn_bound` must identify the one
exact prior turn through the provider-specific non-creating lookup, is
published before another pull, and enters `running_bound`. The uncertain event
ends the stream. Any other first event is a contract failure.

`recover_terminal_only` emits no binding event and leaves lifecycle
`uncertain` through every valid nonterminal observation. It may validate
progress and provider-owned approval pairs in memory, but it never publishes a
running or waiting transition and never approves anything. Only an exact valid
terminal reply or completion bound to the same authenticated turn may publish
`uncertain -> central_pending`. A nonterminal transport loss leaves the row
uncertain; invalid event order or data follows the provider uncertainty rule
below.

`recover_reply_only` likewise emits no binding event and leaves the durable row
`central_pending(reply)` through valid nonterminal observations. Only the exact
valid reply from the same authenticated turn restores the reply bytes in
memory; the durable reply plan is unchanged. A valid stream that cannot return
that reply takes the gated `central_pending(reply) -> uncertain` path. It cannot
publish a completion or enter a normal running or waiting lifecycle. Invalid
event order or data follows the provider uncertainty rule below.

In `running_bound` or `running_unbound`, zero or more `progress` events may
precede an approval or the one terminal event. `turn_bound` is forbidden in
`running_unbound`, including immediately after its first progress or approval
event. On `approval_required`, the connector validates the ID and atomically
publishes `turn_running -> waiting_for_approval`, preserving whether the turn ID
is present, before asking the stream for another event. The next ordinary event
must be `approval_resolved` with the same approval ID. The pending pull may wait
for the provider-owned decision. After validating that event, the connector
atomically publishes `waiting_for_approval -> turn_running` with the same turn-ID
presence before another pull. A later approval uses the same sequence. After
connector-initiated cancellation, an exact terminal event may end a wait
without an `approval_resolved` event.

Recovery of a durable bound `waiting_for_approval` turn starts in
`recover_waiting_bound`. Its first event may be `approval_required`,
`approval_resolved`, or a terminal event for that exact turn.
`approval_required` confirms the wait; the durable state is already published
before the next pull. `approval_resolved` is valid only when the
provider-specific recovery contract proves it describes the most recent wait
on the exact recovered turn. The connector then publishes
`waiting_for_approval -> turn_running` before another pull. A terminal event
moves directly to its durable central plan. Any progress event before that
resolution evidence is invalid. A crash from `waiting_unbound` instead moves
to uncertainty and invokes no provider recovery.

Every invocation emits exactly one terminal event and nothing after it. A
changed or second binding, wrong execution ID, invalid event order, unmatched
approval ID, terminal event followed by data, or stream closure without a
terminal event is a contract failure. The connector requests cancellation with
reason `contract_failure`. Unless the adapter proves that provider input was
not dispatched, the result maps to `uncertain`. Expected provider results use
events, not thrown exceptions. An unexpected adapter rejection or exception
follows the same proof rule.

The connector counts every normalized event returned by one `start`, `resume`,
or `recover` invocation, including bindings, progress, approval events, and the
terminal event. The counter starts at zero immediately before the first pull,
increments once after a closed event passes schema validation, and rejects an
attempted event 10,001. A later `recover` invocation has its own counter but
remains inside the original absolute deadline. The `cancel` result is not a
stream event. The connector processes events one at a time and does not retain
the full stream.

The common port receives only the flat normalized records above. It has no raw
provider envelope to which a meaningful JSON-depth or 1 MiB serialized-event
boundary could apply. Each provider ADR must define its raw SDK object, JSON,
JSONL, or other envelope and parser. That ADR must set a raw event cap no larger
than 1 MiB, a structured depth cap no larger than 100 container levels, and
test both exact boundaries before normalization. A provider interface with no
bounded pre-normalization representation cannot qualify.

Provider session, turn, and approval IDs are opaque sensitive metadata. The
adapter accepts only Unicode scalar strings from 1 through 1,024 UTF-8 bytes,
preserves their exact values without normalization, and never derives meaning,
paths, or commands from them. ADR 0029 accepts the same durable bound.

### Binding barriers

Event delivery is acknowledged when the connector requests the next event.
After `session_bound` or `turn_bound`, the connector publishes the corresponding
opaque state before it requests another event. An adapter may claim that a
binding event is a pre-execution crash barrier only if it can hold the provider
at that point. A provider-specific ADR and fake-provider tests must prove that
claim.

If a provider can act before supplying a stable session or turn ID, the common
port does not invent one and does not treat event delivery as a safe barrier.
A crash in that interval is uncertain. The adapter must not call `start` or
`resume` again to discover what happened.

ADR 0029 contains message `binding -> central_pending` and
`turn_starting -> central_pending` transitions for the exact permitted
terminal plans. It also permits `turn_starting -> turn_running` and
`turn_starting -> waiting_for_approval` with a null provider turn ID, permit
that ID to remain null through the matching running and approval transitions,
and treat the null value as the unrecoverable branch rather than corruption.
Its crash table must move a no-turn `turn_running` or `waiting_for_approval` row
to uncertainty without calling `recover`. None of these states authorizes
another provider call. Any amendment to either ADR must preserve these matched
transitions and row constraints.

If validation or durable publication of a binding, first unbound progress,
approval wait, or terminal plan fails, the connector never requests the next
event. It starts the cancellation clock, calls `cancel` with reason
`state_failure` and the exact IDs held in memory, applies the qualified
containment cleanup, makes no central reply, completion, or acknowledgement
call, and stops with `connector_state_unavailable`. It does not reinterpret the
failure as a definite provider result. On restart, the preceding durable
`binding` or `turn_starting` state permits only qualified exact recovery or
`uncertain/provider_outcome_unknown`; a no-turn running or waiting state permits
only uncertainty. None permits another `start` or `resume`. If cleanup cannot
prove that connector-owned provider work stopped, startup remains blocked and
the inbound message stays open. If the store does not reopen as fully valid,
ADR 0029 blocks startup before this recovery path.

## Local execution policy

The user selects one fixed maximum local policy outside sender-controlled
content. The only proposed maximums are `read-only` and `workspace-write`.
`workspace-write` is the highest permitted maximum. An adapter may narrow the
provider's effective access below the selected maximum, but it may never widen
it.

The user-selected working directory and maximum policy stay fixed for the
turn. The sender cannot change the provider command, model, directory, session,
system instructions, tools, MCP servers, sandbox, approval behavior, or
environment through message text or metadata. The adapter passes message text
only through its approved structured input channel.

Provider-native sandboxing, deny rules, tool restrictions, MCP controls, and
approval checks remain active. The connector never selects an unrestricted,
dangerous, bypass, auto-approve, or equivalent mode. If the selected maximum
cannot be represented without weakening a provider safeguard, that adapter
fails before provider execution.

`approval_required` is open and nonterminal. The connector publishes
`waiting_for_approval` before the next pull, records no central completion, and
permits no acknowledgement. The matching `approval_resolved` event reports
only a decision made through an approved provider-owned interface. The
connector does not synthesize approval, answer a provider prompt, or convert
silence into approval. The first release has no connector-owned approval HTTP
route, MCP tool, CLI command, terminal prompt, file, socket, or environment
control. A provider-specific ADR may rely on an existing provider-owned
approval interface only after it fixes and tests that interface and proves that
the connector neither grants nor widens the decision. Without such an approved
provider interface, the turn remains waiting until its absolute deadline and
is then cancelled under the safe rules below.

## Cancellation and overflow

At the 15-minute deadline, during shutdown, or after an output, contract, or
state failure, the connector calls `cancel` for the active `execution_id` with
the matching fixed reason and any exact provider session or turn ID already
known. Let `D` be the durable `turn_deadline_ms`, and let `C` be the validated
wall-clock instant immediately before `cancel`. The grace ends at
`min(C+10000, D+10000)`. A restart or late recovery therefore receives only the
remaining part of the one absolute grace. At or after `D+10000`, there is no
grace and forced cleanup begins immediately. No cancellation path creates a new
deadline or a fresh ten seconds. After the remaining grace expires, the
approved provider/platform containment mechanism has 3 seconds to force
cleanup and confirm that no connector-owned provider execution remains.

Shutdown also obeys ADR 0028's one 15-second process budget. It spends no more
than the first second stopping admission, closing the listener, and cancelling
gateway MCP work. Provider cancellation, only the remaining absolute grace,
and containment cleanup must finish within the next 13 seconds. The final
second closes state and releases the singleton. If that shutdown-specific
sequence cannot prove provider cleanup, the process writes
`connector_shutdown_incomplete` and exits `1`. It does not use the ordinary
runtime cleanup code.

The connector captures at most 8 MiB of stdout and 8 MiB of stderr for one
provider turn. Captured bytes stay in memory and are used only by the approved
adapter parser. They are never copied into errors or diagnostics. The adapter
must keep draining or terminate the process so a full pipe cannot deadlock
shutdown.

The connector rejects normalized event 10,001, stdout byte 8,388,609, stderr
byte 8,388,609, progress-text byte 262,145, or final-reply byte 262,145. It
stops accepting output, requests cancellation with reason `output_limit`,
applies only the remaining absolute grace, and then applies the qualified
forced cleanup if needed. Provider-specific raw depth and event-byte excesses
enter the same cancellation path after that adapter's approved parser detects
them.

An adapter may own at most one root provider process for an active turn. This
common contract does not claim that Node can enumerate or reap every descendant
on every operating system, and it sets no universal descendant-count limit. A
subprocess adapter's provider-specific ADR must select a containment mechanism
for each claimed platform and prove all of these properties:

1. The provider root and every child it may create remain in one enforceable
   containment unit or the adapter refuses to run.
2. Forced cleanup terminates every member within 3 seconds and confirms that
   the unit is empty without inspecting command lines or environments.
3. The connector reaps its direct child and the operating-system mechanism
   owns cleanup of other members. The connector does not claim to reap a
   process that is not its child.
4. A hard connector crash terminates the containment unit without relying on a
   later process scan or reusable operating-system identifier.

A raw PID or process-group number is not a hard-crash recovery mechanism. A
provider/platform pair that cannot prove these rules is unsupported. An
in-process or remote adapter must instead prove that connector death leaves no
connector-owned local execution and that exact provider-turn recovery or
cancellation covers any provider-native work. Those proofs and any platform
API or dependency remain provider-specific decisions.

Each subprocess provider/platform ADR must also fix an enforceable descendant
count or prove that its approved interface creates none. It may not inherit an
unbounded process tree from this common contract. The number and enforcement
mechanism are provider-specific because the common Node process API cannot
measure the same containment unit on every target platform.

Overflow does not by itself prove a safe failure. If the connector observed an
exact provider terminal result and only that result is invalid or too large,
it records `failed` with `provider_result_invalid`. If provider work may still
have been running when parsing or capture stopped, the connector recovers the
exact turn or records `uncertain` with `provider_outcome_unknown`.

Cancellation maps to `cancelled_before_execution` only when the connector can
prove that no provider call began. It maps to `cancelled_during_safe_wait` only
when the adapter proves that the turn was waiting without stateful provider
work, including a provider-native approval wait. A signal, timeout, closed
pipe, process exit, or successful containment cleanup is not proof that no work
occurred. The default after possible execution is exact recovery or
`provider_outcome_unknown`.

## Central outcome and acknowledgement

The connector uses only the outcomes and reason codes accepted in ADR 0025:

| Proven local result | Central action |
| --- | --- |
| Valid nonempty reply text | Call `reply_message` with the exact text |
| Explicit successful no-reply result | Call `complete_message` with `completed_without_reply` and `no_reply_required` |
| Unsupported message type | Call `complete_message` with `unsupported` and `unsupported_message_type` |
| Unsupported payload proven before provider work | Call `complete_message` with `unsupported` and `unsupported_payload` |
| Provider could not start and no provider work occurred | Call `complete_message` with `failed` and `provider_start_failed` |
| Exact provider turn reports a definite execution failure | Call `complete_message` with `failed` and `provider_execution_failed` |
| Exact terminal provider result is malformed, empty when a reply is required, or over limit | Call `complete_message` with `failed` and `provider_result_invalid` |
| Cancellation proven before execution | Call `complete_message` with `cancelled` and `cancelled_before_execution` |
| Cancellation proven during a safe approval or equivalent wait | Call `complete_message` with `cancelled` and `cancelled_during_safe_wait` |
| Provider work may have occurred and its exact result cannot be recovered | Call `complete_message` with `uncertain` and `provider_outcome_unknown` |

No other local outcome or reason code is permitted. A definite failure needs
positive evidence from the adapter or from a pre-dispatch connector check.
Missing evidence is not a definite failure.

Before recording any terminal completion after cancellation, overflow, or
uncertainty, the connector must prove through the qualified mechanism that no
connector-owned provider execution remains. If cleanup cannot be confirmed for
a valid admitted row, it atomically moves that message to `blocked`, sets
ADR 0029 `blocked_class=cleanup`, clears the retry schedule, preserves all
other durable state, leaves the message open and unacknowledged, and stops with
the fixed content-free error `connector_provider_cleanup_incomplete`. If no
message row was admitted, it does not invent one. If the blocking write fails,
it stops with `connector_state_unavailable`. A later startup that observes the
valid blocked row stops with `connector_message_blocked`. A provider adapter
cannot qualify on a platform where containment is weaker than this rule.

The connector calls `ack_message` only after it has observed the exact accepted
reply result or exact recorded completion result. If a reply or completion
response is lost, it changes the durable retry kind to `outcome_lookup` before
another central request. If an acknowledgement response is lost, it keeps
retry kind `ack`. A matching terminal outcome permits acknowledgement. An open
result permits repetition only with the exact in-memory or recovered reply, or
the same durable completion tuple. It never starts or resumes another provider
turn to resolve a central transport uncertainty.

ADR 0025 outcome lookup does not return a completion reason code. For a planned
reply, a matching terminal result means `status=terminal`, `outcome=replied`,
and one valid non-null reply message ID. For a planned completion, it means
`status=terminal`, an `outcome` equal to the planned completion outcome, and a
null reply message ID. The connector neither requires nor infers a reason code
from lookup. It already owns the durable reason used in its completion request.
A different terminal outcome, wrong message or conversation ID, or invalid
reply-message-ID nullability is a gateway contract failure.

There is one exact path when a reply response was lost and the reply bytes no
longer exist. First, `get_message_outcome` must return the exact `open` result,
which proves that central did not commit a reply or completion. The connector
then attempts only exact-turn recovery within the recovery rules. If recovery
does not return the exact reply, it applies these two durable transitions:

1. Atomically move message `central_pending(reply) -> uncertain`, move an
   `active` conversation to `uncertain` or leave an already uncertain
   conversation unchanged, and clear `terminal_operation`, completion fields,
   `retry_kind`, and `retry_not_before_ms`. Preserve the lifetime central
   attempt count, provider IDs, and absolute deadline.
2. After qualified cleanup proves that no connector-owned provider execution
   remains, atomically move message `uncertain -> central_pending`, set only
   `terminal_operation=complete`, `completion_outcome=uncertain`,
   `completion_reason=provider_outcome_unknown`, and `retry_kind=complete`, and
   leave `retry_not_before_ms` null so the first fixed completion request may be
   claimed immediately.

A crash between those transitions resumes only from `uncertain`; it cannot
restore the reply plan or dispatch provider input. ADR 0029 contains this exact
`central_pending -> uncertain` transition and permits the cleared-plan
uncertain row. Directly overwriting a reply plan with a completion plan is
forbidden.

If `reply_message` returns `mailbox_full`, central has recorded neither a reply
nor a terminal outcome. The connector keeps the exact recovered reply bytes in
memory, keeps the message open and unacknowledged, and retries only that reply.
It does not regenerate, summarize, truncate, or ask the provider to produce the
reply again. A crash loses those bytes. After restart, the connector may obtain
them only by recovering the exact provider turn. If exact recovery fails, it
records `uncertain` with `provider_outcome_unknown`; it never replays the
provider input.

### Central retry schedule

The connector uses one lifetime schedule for central delivery-control work on
an inbound message. There are no retry cycles. A wake, restart, operation-kind
change, successful intermediate call, or `open` outcome never resets or lowers
the durable attempt count and never moves the durable next-attempt time earlier.
One message has at most one in-flight central delivery-control request. The
durable state transition that claims an attempt happens before dispatch and
serializes competing timers, wakes, and restart recovery.

Immediately before each central request, the connector atomically stores the
pending operation kind and increments the message's attempt count. The count
starts at `1`, saturates at `255`, and never wraps. After failed attempt `n`,
the base delay is:

| Failed attempt | Delay before the next eligible request |
| ---: | ---: |
| `1` | 1 second |
| `2` | 2 seconds |
| `3` | 4 seconds |
| `4` | 8 seconds |
| `5` | 16 seconds |
| `6` and later | 30 seconds |

The connector stores the exact absolute next-attempt time. Once the count has
saturated, requests remain at least 30 seconds apart. `get_message_outcome`
and a reply deferred by `mailbox_full` always have a 30-second minimum even
when the base delay is shorter. A valid `rate_limited` result uses the greater
of the base delay and its exact ADR 0025 `retry_after_ms`, which is at most
60,000 milliseconds. No accepted central result supplies a 300-second delay.
Restart after the stored time permits one request; restart before it does not.
An authenticated wake only coalesces the message ID and cannot trigger an
early request.

Only the following observations permit another central request. `Current kind`
and `Next kind` are exact ADR 0029 `retry_kind` values:

| Current kind | Observation | Next kind and action |
| --- | --- | --- |
| `reply` | Exact successful reply | `ack`; persist the accepted terminal state and claim acknowledgement immediately |
| `complete` | Exact successful completion | `ack`; persist the accepted terminal state and claim acknowledgement immediately |
| `ack` | Exact successful acknowledgement | none; move to `closed`, then delete the message row under ADR 0029 |
| any | Definite local pre-dispatch failure | unchanged; set the base delay only when there is proof that no gateway request began |
| `reply` or `complete` | Uncertain transport result | `outcome_lookup`; never repeat the side-effecting operation first |
| `outcome_lookup` | Uncertain transport result | `outcome_lookup` after at least 30 seconds |
| `ack` | Uncertain transport result | `ack` after the base delay |
| any | `rate_limited` | unchanged after the greater exact delay described above |
| any | `temporarily_unavailable` | unchanged after the base delay |
| `reply` | `mailbox_full` | `reply`; keep and retry only the exact reply bytes after at least 30 seconds |
| `reply` or `complete` | `message_already_terminal` | `outcome_lookup` after at least 30 seconds |
| `outcome_lookup` | Exact `open` and exact reply bytes remain or exact recovery returns them | `reply`; repeat only those exact bytes |
| `outcome_lookup` | Exact `open` and a durable completion tuple exists | `complete`; repeat only that tuple |
| `outcome_lookup` | Exact `open` after a lost reply and exact recovery cannot return the reply | none during `central_pending(reply) -> uncertain`, then `complete` for the fixed two-transition uncertain path above |
| `outcome_lookup` | Exact matching terminal outcome | `ack`; persist `ack_pending` and claim acknowledgement immediately |

`mailbox_full` from another operation is a contract failure.
`message_not_terminal` from `ack_message` after a previously accepted terminal
result is also a contract failure and never changes retry kind to
`outcome_lookup`. The permanent
application codes `invalid_request`, `recipient_unavailable`,
`message_not_found`, `idempotency_conflict`, `receive_in_progress`,
`protocol_mismatch`, and `request_too_large` stop the connector and leave the
message open and unacknowledged. So does
`message_already_terminal` or `message_not_terminal` on an operation not
handled in the table.

Authentication, DPoP, credential, and key failures never enter this schedule
and never trigger registration, reissue, recovery, or replacement. An unknown
error code, invalid retry delay, malformed or oversized result, wrong message
ID, terminal outcome that differs from the planned local result, or other
gateway contract failure stops the connector and leaves the message open. No
remote error prose is reflected. No retry path submits provider input.

Before one of these permanent stops, a valid admitted row moves immediately
and atomically to `blocked` with the original failure class. That durable stop
precedes any cancellation or cleanup, clears `retry_kind` and
`retry_not_before_ms`, and preserves every other durable field. A crash during
cleanup therefore recovers only the blocked row and permits no provider or
central request. The durable class is exact:

| Observation | ADR 0029 `blocked_class` |
| --- | --- |
| A listed permanent central application code | `permanent_application` |
| Authentication, DPoP, credential, or key failure | `authentication` |
| Unknown or malformed gateway result, gateway identifier or outcome mismatch, or `migration_incomplete` in this fresh-install target | `contract` |
| Inability to prove required provider containment or cleanup is itself the original stop | `cleanup` |

The connector does not create a row for a pre-admission failure. Failure to
commit the blocking transition is instead `connector_state_unavailable`. A
blocked row is never reclassified. If cleanup after another permanent stop
also fails, only the process stderr code changes to
`connector_provider_cleanup_incomplete`; the original durable blocked class
remains. Recovery of a valid blocked row makes no automatic provider or
central request and stops with `connector_message_blocked`.

### Runtime failures and process result

Runtime stderr uses exactly `a2a connector: <fixed_error_code>\n`. It never
adds remote prose, a provider value, identifier, path, URL, header, body, event,
or raw error. A condition marked `continue` writes nothing to stderr except the
fixed capacity warning below. A stop first performs only the safe cancellation
and cleanup permitted above after any required permanent blocked transition is
durable. If cleanup then fails, its fixed cleanup code replaces the original
process code without reclassifying the blocked row.

| Condition | Fixed stderr code | Exit | Process action |
| --- | --- | ---: | --- |
| Parsed webhook rejection in the HTTP table | none | none | `continue`; return or close exactly as the webhook contract requires |
| Accepted retryable central observation in the retry table | none | none | `continue`; retain the lane and wait until the durable retry time |
| Valid provider terminal event or accepted central intermediate result | none | none | `continue`; advance only through its durable transition |
| A new conversation reaches ADR 0029's lifetime row ceiling | `connector_state_capacity` | none | `continue`; insert no row, start no provider or central terminal operation, remove that ID from the current queue, and leave its gateway body open for redelivery; existing mappings remain eligible |
| Later work reaches a `closed` or blocked `uncertain` conversation | `connector_conversation_unavailable` | `1` | `stop`; leave the later message open and unacknowledged |
| State open, validation, write, binding publication, database-page capacity, corruption, or clock check fails | `connector_state_unavailable` | `7` | `stop`; never repair, reset, or continue in memory |
| Ordinary runtime cancellation or containment cannot prove provider cleanup | `connector_provider_cleanup_incomplete` | `1` | `stop`; first persist `blocked/cleanup`, then leave the message open with no central terminal call |
| A permanent central application error, authentication or DPoP failure, malformed result, mismatched outcome, or other gateway contract failure occurs | `connector_gateway_operation_failed` | `1` | `stop`; first persist the exact original blocked class above, then perform any required cleanup, retain content-free state, and leave the message unacknowledged |
| Startup recovers a valid blocked message row | `connector_message_blocked` | `1` | `stop`; make no automatic provider or central request |
| An unexpected connector failure has no more specific row | `connector_internal_error` | `1` | `stop`; retain content-free state and expose no raw error |
| `SIGINT` or `SIGTERM` completes ADR 0028's bounded shutdown | none | `0` | `stop` cleanly |
| ADR 0028 shutdown cannot finish or prove cleanup inside 15 seconds | `connector_shutdown_incomplete` | `1` | `stop`; leave affected work open and do not emit `connector_provider_cleanup_incomplete` |

Startup and `retire-state` keep ADR 0028's separate startup error table. A
provider result such as `failed`, `cancelled`, or `uncertain` is a message
outcome, not process stderr. An HTTP capacity response and a scheduled central
retry are also not process failures.

## Restart and crash behavior

ADR 0029 provides the proposed atomic content-free state transitions for this
behavior. This ADR does not change that mechanism or its cryptography.

For a subprocess adapter, the later provider/platform ADR must prove that an
unclean connector exit automatically empties its containment unit. Startup
never tries to find or kill a prior child by name, command line, environment,
working directory, PID, or process-group guess. If owner-death cleanup cannot
be guaranteed, that provider/platform pair remains unsupported. Exact
provider-native turn recovery still runs under the original deadline after
local containment is known to be empty.

| Boundary | Proposed recovery |
| --- | --- |
| Wake accepted but still queued | The memory-only queue disappears. Gateway redelivery supplies the same opaque ID; no provider turn has started |
| Message row remains `received` | No deadline or dispatch decision exists. Gateway redelivery supplies the body and permits the one initial `received -> binding|turn_starting` transition |
| Message committed `binding` or `turn_starting`, even if a later check proves the port call did not begin | Never call `start` or `resume` again. Record a safe pre-turn completion only from positive evidence, use the provider-specific non-creating recovery allowed by durable IDs, or record uncertainty |
| `start` or `resume` may have reached the provider before a binding is durable | After containment cleanup, recover only if durable exact IDs permit it; otherwise record `provider_outcome_unknown` and never replay input |
| Session ID is durable and lifecycle remains `turn_starting`, but no turn ID is durable | Use session-only recovery only when the provider ADR proves a non-creating lookup that first binds the exact prior turn; otherwise record uncertainty |
| Lifecycle is `turn_running` or `waiting_for_approval` with no turn ID | Record uncertainty after qualified cleanup; do not call `recover`, `start`, or `resume` |
| Exact turn ID durable and its absolute deadline remains | Invoke `recover` for that exact turn for no more than the remaining interval; do not invoke `start` or `resume` |
| Absolute deadline passed while the connector was stopped | Submit no input; attach only to cancel an exact recoverable turn using no more than the grace remaining before `turn_deadline_ms+10000`, then complete only from proven terminal or uncertainty evidence |
| Connector hard-crashes with a provider root or child alive | The approved containment unit dies with its owner; then recover the exact provider turn or record uncertainty without replay |
| Provider waits for approval | Recover only a bound exact turn within the original deadline; a no-turn wait becomes uncertain. The connector has no approval interface and never approves or replays automatically |
| Terminal reply exists only in memory | Recover a bound exact turn and reply, or record uncertainty. A no-turn crash always takes the uncertainty path and never generates a replacement turn |
| `mailbox_full` left an exact reply in memory | Retry the same bytes while alive; after a crash, recover the exact turn or record uncertainty |
| Reply or completion request may have committed | Call `get_message_outcome`; use its exact terminal or open result before repeating anything |
| Outcome lookup proves `open` after a lost reply and exact recovery cannot return the bytes | Perform the two durable `central_pending(reply) -> uncertain -> central_pending(complete)` transitions; never restore the reply plan or start provider work |
| Reply accepted or completion recorded, acknowledgement not observed | Repeat only idempotent `ack_message` until the exact `acked` result is observed; `message_not_terminal` is a contract failure |
| Acknowledgement may have committed | Repeat `ack_message`; central returns the same content-free tombstone result |
| Conversation is `uncertain` and another message arrives | Start no provider work; keep the uncertain lane blocked and stop with `connector_conversation_unavailable` |
| Conversation is `closed` and another message arrives | Treat it as a central contract failure, start no provider work, and leave the later message open |

After the exact `acked` result, the connector releases the conversation lane
and global turn slot, removes the raw message and reply from memory, and keeps
only the content-free state permitted by ADR 0029.

## Fake-provider acceptance cases

No test work starts until G04 is complete; the user accepted this ADR and the
other D05 records on 2026-08-30.
If accepted, the fake provider and fake gateway must cover at least these
cases:

| ID | Case | Expected result |
| --- | --- | --- |
| W01 | Send well-formed request lines of exactly 2,048 and 2,049 octets, then valid webhook requests with header blocks of exactly 16,384 and 16,385 octets | Parse the 2,048-octet line and apply its path result, reject 2,049 with the line error, accept the exact header boundary, and reject its excess |
| W02 | Send timestamps exactly 300 seconds old and 5 seconds ahead, then 301 seconds old, 6 seconds ahead, `00`, a 13-digit value, and `253402300800` under deterministic clocks | Accept both time-window boundaries; reject syntax, range, and window excesses before reading the body |
| W03 | Repeat the same valid timestamp and signature | Reject as replay before JSON parsing and start no provider turn |
| W04 | Fill the 4,096-entry live replay cache, try entry 4,097, then advance beyond one entry's acceptance window | Reject entry 4,097 without evicting a live pair; admit a new pair only after deterministic expiry |
| W05 | Declare and send exactly 1 MiB, then declare 1 MiB plus one byte | Process the bounded body only after valid auth; return `413` for the over-limit declaration without reading its body |
| W06 | Sign malformed JSON, duplicate keys, unknown keys, or mismatched request IDs | Verify HMAC, then reject strict parsing without queueing work |
| W07 | Repeat a valid wake with a new timestamp and signature | Coalesce the same message ID and start no duplicate turn |
| W08 | Open a zero-byte socket, drip the request line or headers, then stall after authenticated headers or after a response begins | Start both clocks at accept; close without a response before commitment, truncate and close after commitment, and never select behavior from auth validity |
| W09 | Hold 32 sockets and 16 parsed requests, then add one of each | Destroy socket 33 without application I/O; reject parsed request 17 with the fixed capacity error; recover capacity after close |
| W10 | Send case-varied duplicate equal and conflicting content lengths, any transfer encoding, early EOF, surplus already buffered before commitment, surplus arriving after commitment, a pipelined second request, and a second keep-alive request | Reject every pre-commit ambiguous frame with no wake; preserve the first committed decision for later bytes, process no second request, and close every connection |
| W11 | Send valid leading or trailing OWS, internal OWS in exact-value headers, case-varied duplicate security headers, wrong Host or Origin, bad bearer, and invalid HMAC | Accept only permitted edge OWS, reject duplicates case-insensitively, read a body only after pre-body checks, and never expose which authentication value failed |
| Q01 | Queue 100 distinct IDs, then send another | Keep the first 100 in order and reject the new wake without eviction |
| Q02 | Send two messages for one conversation and messages for other conversations | Run one turn for that conversation and no more than two globally |
| Q03 | Deliver a later message to a `closed` or blocked `uncertain` conversation | Start no provider operation, leave the later message open, and stop with the fixed conversation error |
| P01 | Exercise every `start` first-event and transition edge with bound-turn and session-only fakes | Require the session binding; accept either an early durable turn binding or the exact no-turn progress, approval, and terminal transitions; preserve the safe pre-turn evidence rule |
| P02 | Exercise every `resume` first-event and transition edge with bound-turn and session-only fakes | Use only the stored session ID, emit no session binding, accept the same bound or unrecoverable branches, and never accept a sender-supplied selector |
| P03 | Recover an exact turn, use approved session-only lookup from `turn_starting`, then crash no-turn running and approval states | Bind before output on either recoverable path; map both no-turn crash states to uncertainty without any provider call or input replay |
| P04 | Sender text names a command, model, directory, session, system prompt, tool, MCP, sandbox, approval, or environment value | Treat all of it as input text and change no execution setting |
| P05 | Provider requests approval, resolves it through the provider-owned interface, repeats approval, and probes connector HTTP, MCP, CLI, stdin, files, sockets, and environment for a control | Publish `waiting_for_approval` before each next pull, require matching `approval_resolved`, publish `turn_running` before continuing, expose no connector approval interface, and grant nothing automatically |
| P06 | Restart repeatedly during execution or approval wait, present a clock earlier than any durable `updated_at_ms`, and restart before, at, and after `turn_deadline_ms+10000` | Reuse one durable deadline, fail closed on rollback, grant only the remaining absolute grace, and start forced cleanup immediately when none remains |
| P07 | A subprocess adapter leaves a child or grandchild after cancellation | Use only its approved platform containment, finish forced cleanup within 3 seconds, reap the direct child, and confirm the unit is empty |
| P08 | Hard-kill the connector while a fake provider root and grandchild run | The approved owner-death containment removes both without a restart scan; recovery never guesses by PID or starts another provider turn |
| P09 | Fail durable publication after `session_bound`, `turn_bound`, first no-turn progress, first no-turn approval, and a no-turn terminal | Pull no next event, cancel and clean up, make no central terminal call, stop with the state error, and never start or resume on restart |
| P10 | Return every missing, unknown, mistyped, misordered, wrong-execution, duplicate or late binding, unmatched approval, post-terminal, cancel-result, and closed-stream violation in each automaton state | Reject the exact violation, including `turn_bound` after no-turn progress or approval; report a definite failure only with proof that provider input was not dispatched, otherwise report uncertainty |
| B01 | Emit 10,000 events and then 10,001 | Accept the boundary; reject the excess and recover or report uncertainty |
| B02 | Emit session, turn, and approval IDs of 1,024 UTF-8 bytes and then 1,025 | Accept each reachable field boundary; reject each excess without publishing it |
| B03 | Emit progress text of 262,144 UTF-8 bytes and then 262,145 | Accept the reachable normalized boundary; reject the excess without reflecting it |
| B04 | Emit 8 MiB of stdout or stderr and then one extra byte | Accept each boundary independently; cancel on the excess and retain no captured bytes after the turn |
| B05 | Return reply text of 262,144 UTF-8 bytes and then 262,145 | Accept the boundary; reject the excess without truncation |
| O01 | Produce each exact ADR 0025 terminal result | Send only its matching outcome and reason code, then acknowledge only after central records it |
| O02 | Exit, close a stream, overflow, or die after provider work may have occurred | Recover the exact turn or record `uncertain/provider_outcome_unknown`; never call `start` or `resume` again |
| O03 | Lose a reply response, prove `open`, then fail exact reply recovery | Clear the reply plan only through `central_pending(reply) -> uncertain`, then publish and send the fixed uncertain completion without provider redispatch |
| O04 | Return `mailbox_full` for a reply | Keep the exact reply in memory, leave the message unacknowledged, and start no replacement provider turn |
| O05 | Fail central operations through the 1, 2, 4, 8, 16, and 30-second steps, saturate the attempt count, send wakes before and after the stored time, then restart | Follow one lifetime schedule, never lower the count or time, and never accelerate or replay provider input |
| O06 | Return every accepted application error, an auth or DPoP failure, an unknown code, malformed result, mismatched terminal outcome, and uncertain transport result for each delivery-control operation | Follow the exact error matrix; stop on permanent or contract failures and use outcome lookup before repeating an uncertain reply or completion |
| C01 | Crash at every binding, terminal, reply, completion, outcome-lookup, and acknowledgement boundary | Reach one central terminal outcome and one acknowledgement without duplicate provider work |
| C02 | Restart with only an exact session ID, then with an exact session and turn ID | Use only the provider-specific recovery proven safe for that state; otherwise record uncertainty |
| C03 | Crash before and after `received -> binding|turn_starting`, including after proving the marked port call did not begin | Permit one initial dispatch only while the durable row remains `received`; never redispatch from a deadline-bearing state; otherwise recover or record a fixed terminal result from evidence |
| C04 | Crash after the lost-reply `central_pending(reply) -> uncertain` transition and before the fixed completion plan is published | Resume only the uncertain completion path, never restore the reply plan, preserve the attempt count, and start no provider work |
| S01 | Scan connector state, output, diagnostics, temporary paths, crash artifacts, argv, and copied environment | Find no A2A text, reply, provider output, approval detail, token, credential, or sender-controlled execution option |

Boundary tests use exact-size UTF-8 and structured inputs, a deterministic
clock, raw TCP clients, process barriers, and real child processes. They must
prove both the expected provider or central effect and the absence of a
duplicate turn, reply, completion, or acknowledgement. A test that passes only
because the provider never started is not evidence for a crash or uncertainty
case.

Each provider-specific red suite also owns the exact accepted and one-over raw
event byte and depth cases for its approved interface. Those cases are not
common-port B02 or B03 and cannot pass from normalized fake events.

The request, scheduler, port-schema, and in-process fake-provider cases run on
every connector CI platform. P07 and P08 run with real process trees for every
provider/platform pair that claims subprocess support. A platform may remain
explicitly unsupported, but its jobs cannot skip those cases and still produce
a support claim. No test selects a real provider executable, SDK, protocol, or
containment dependency before its provider-specific ADR.

## Security effects

This accepted contract limits connector authority rather than granting new
authority.
The sender supplies text, not execution settings. The user fixes a local
maximum policy, and adapters may only narrow it. Provider safeguards remain in
force. Authentication and replay checks happen before body parsing, and raw
content remains memory-only.

The two-turn cap can stall the connector when both active messages await
approval, central recovery, or mailbox capacity. That is intentional. Opening
more provider turns would trade availability for more memory, more local
authority, and a larger duplicate-work window.

The in-memory replay cache does not survive restart. Durable duplicate
prevention comes from the opaque execution state and central idempotency, not
from persisting webhook bodies or HMAC material.

## Alternatives

- Let every adapter define its own outcomes and limits. This makes the same
  crash safe for one provider and replayable for another.
- Retry after any process failure. The process may already have changed files
  or called an external service.
- Persist replies until central accepts them. This would put provider output
  into connector durability and violate ADRs 0024 and 0025.
- Allow sender-selected models, directories, tools, or approval modes. This
  turns untrusted message content into local execution authority.
- Use provider-specific approval bypasses for headless work. This defeats the
  user's existing provider controls.

## Provider and dependency impact

None is selected. This record names no Codex, Claude Code, or Gemini command,
SDK, transport, event schema, version, package, or dependency. Each provider
ADR must show how its chosen interface implements the common port, exposes a
stable session identifier and any stable per-turn identifier the provider
actually supplies, preserves safeguards, and honors cancellation and bounds.
An adapter that supplies a stable turn identifier must prove exact recovery
without starting a new turn. An adapter that cannot supply one must qualify the
unrecoverable branch and prove that a crash from a no-turn running or approval
state records uncertainty without recovery, redispatch, or input replay.

The connector runtime, process library, JSON parser, HMAC implementation,
state store, packaging, and supported platforms remain separate decisions.
No package may be installed and no platform may be claimed from this proposal.

## Approval gate

Approved by the user on 2026-08-30. This freezes the provider-neutral port,
all fixed limits, webhook admission order, local maximum policy, failure
mapping, crash behavior, and fake-provider cases. ADRs 0028, 0029, and 0031
were accepted with this record and complete D05. ADR 0032 permits K01 against
the accepted G04 fixture contract. Each real provider interface remains behind
its provider-specific ADR.
