# Review of three stalled user sessions

Date: 2026-09-05

Status: findings and proposed design corrections. Implementation is paused for
discussion at the user's request. Examples below omit personal payloads and
local machine paths from the supplied logs.

## What the excerpts establish

| Case | Evidence | Conclusion |
| --- | --- | --- |
| OpenClaw, 13:53 UTC | Central delivers a phone-number action call. ACP initializes and loads a session. Ambassador handles `get_inbox` and returns the pending call in about 3 ms. The excerpt ends there. | Enrollment, central receipt, ACP startup, and local tool handling worked. The excerpt does not establish whether OpenClaw received the tool result, continued, or stalled. The user does not know whether later output followed. |
| Claude, 14:11 UTC | Claude receives a free/busy action, says it lacks the calendar data, asks for availability in ACP text, and ends the turn. Ambassador acknowledges the notification. No owner-input tool call appears. | The action needs human input, but the question remains in the background session. There is no visible, structured path in this turn to obtain the answer and resume. |
| Claude, 14:14 UTC | Central returns a successful phone-number result for the same call as the OpenClaw excerpt. Claude reports success but says it should not relay the data through unsupported channels. The turn ends and Ambassador acknowledges the notification. | The result reached Ambassador. The user-facing result is replaced by a status summary in a separate ACP session. This is a delivery and guidance failure, not evidence of a permission rejection. |

`get_free_busy_permission` is an action name in the reviewed catalog, despite
its suffix. These messages reached their targets. Do not diagnose another name
mismatch or rename this action based on its name alone.

## Confirmed gaps

### Missing user input has no explicit continuation

The delivery prompt instructs an agent to leave a call pending when it cannot
answer. The pending inbox preserves the action but has no structured question,
input-request correlation, or waiting reason. ACP text is logged, not routed
back into the initiating human conversation. A user who does not inspect that
separate session cannot know what information is needed.

Add a bounded `ask_owner` business message tied to a pending action. Persist its
question and correlation before requesting input, expose a waiting-for-owner
state, and resume the exact action when the answer arrives. Keep this separate
from resource permission and provider-tool approval. Do not infer missing input
or fabricate questions by parsing the model's free-form prose.

Central's existing `get_human_input` supports text and buttons, emails the
authenticated agent's owner, and returns a correlated `human_input_response`.
Ambassador currently supports only buttons and invokes it only for ACP tool
approval. The text path is an integration change requiring contract fixtures
and live qualification, not a new server endpoint. Retain the triggering
central message ID with pending input state so correlation survives a restart.

Also distinguish an unavailable calendar integration from information the user
can supply. These excerpts show no calendar lookup attempt, so the model's
statement alone does not prove which provider tools were available.

### Returned results are not presented to the requesting user

The phone result should be returned as data through the requesting operation's
message-box response, or a verified native conversation route. Do not depend
on a second ACP model deciding whether to reveal the result. State explicitly
that presenting a requested action result to the enrolled requesting owner is
a supported path. Credential and unrelated-data restrictions remain intact.

Retain results until the receiving client acknowledges them. Central receipt,
ACP turn completion, result availability, and client receipt are different
states. Acknowledging a notification after durable local capture is valid; it
does not establish that the business action completed or the human saw it.

### Serial polling would block the new long poll

`NotificationRelay` receives a batch, captures it, then awaits every delivery
before requesting another batch. An ACP turn can itself call Ambassador tools.
If that turn waits in `message_box` for central data, the next normal poll is
blocked by the very turn that needs the data. The special ACP approval poll is
not a general solution for this dependency.

Separate one central receive/capture loop from bounded agent delivery workers.
Feed operation waiters and approval/input coordinators from that receiving
owner. Preserve per-session execution ordering, bounded queues, custody and
acknowledgement rules. Do not create competing central pollers. Test an ACP
turn waiting in an MCP tool while a later central result or owner answer arrives.
The supplied OpenClaw excerpt is too short to prove this caused its apparent
stall; the blocking dependency is established by the code.

## Other signals that need care

Claude refers to two free/busy call IDs for the same date. This is consistent
with retrying an action as a new request, but the excerpts do not establish who
submitted the other call or whether it was intentional. Repeated checks must
reuse the saved request ID. Do not merge distinct central calls by matching
their payloads, and do not submit results for old call IDs based only on model
memory. Inspect the current pending inbox before answering each call.

The messages are about 25.5, 30.9, and 32.2 seconds old when the logged polls
return, while those HTTP requests take only 122, 131, and 209 ms. This is elapsed
time from the server's creation timestamp to the client's receipt timestamp,
not a measured network queue duration. Earlier polls and delivery turns are
needed to locate the delay, and cross-machine clock differences remain possible.

The reviewed central poll handler queries the queue before installing its
waiter and returns an empty response on timeout without querying again. A
notification in that gap can leave a message until the following poll. This
source-level race is already covered by
[API issue 3](https://github.com/embassys/agent2agent/issues/3). It is consistent
with a roughly thirty-second delay, not proved as the cause of these examples.

## Checks to add before resuming implementation

- Missing calendar data creates a real owner-input request and a visible waiting
  state. An owner answer resumes only its correlated pending action.
- A successful result reaches the requesting operation with its actual data,
  survives a disconnected response, and leaves storage only after receipt.
- An ACP turn waiting in `message_box` does not block central message capture,
  other operation updates, or its own answer.
- Repeated checks create no new permission or action call. Separate calls remain
  independently tracked even when their input is identical.
- Diagnostics identify MCP request completion, transport completion or closure,
  ACP activity, waiting reason, and time spent before capture separately.

The review used the supplied excerpts, current Ambassador code, and central
revision `708f205bfaee5010eb86fcfae55967fb5d02071c`, rechecked against main.
No implementation or central API code was changed during this review.
