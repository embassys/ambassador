# Request and answer an action

Keep Ambassador running and register through your configured agent first.
Each person uses their own enrolled identity and decides permissions by email.
This guide describes the unpublished ADR 0061 candidate.

## Request work

Tell your agent what you want, who should receive it and the actual details.
The agent checks `list_action_types`, then calls `message_box`:

```json
{
  "type": "request_action",
  "request_id": "ac33b5cd-49ad-4e82-8a5a-e5d0b3109632",
  "target_email": "alex@example.com",
  "action_type": "get_phone_number",
  "decision_options": "once_always",
  "reason": "Arrange tomorrow's meeting",
  "payload": { "reason": "Arrange tomorrow's meeting" }
}
```

Generate a new request UUID for new work. Keep it when checking this request.
Ambassador validates the exact catalog action and payload, saves the intent
encrypted, emails the grantor if needed, and submits once after a matching grant.
An existing grant may allow immediate submission.

The initial tool call stays open for up to ten minutes for a related update.
After timeout, the agent tells you no update has arrived and you can ask again.
It uses the returned `check` continuation for another ten-minute wait, preserving
the UUID. Closing the chat or cancelling a wait does not cancel accepted work.

Use `request_permission` instead of `request_action` for permission alone,
without `payload`. A grant alone never creates an action. Always use the
same exact catalog name for permission and action. A grant for
`read_calendar_permission` does not authorize `read_calendar_event_by_title`.
An action named `get_free_busy_permission` may itself be a callable catalog
action; the suffix does not define its meaning.

## Answer incoming work

The configured incoming agent receives the call. It uses `message_box` with
`type: "submit_action_result"`, a new request UUID, the original `call_id`,
`status: "success"` or `"error"`, and a structured `result`.

When information is missing, it calls `ask_owner` with the pending call ID,
a new question request UUID, the question and `input_type: "text"` or
`"buttons"`. Ambassador emails your registered address and returns
`waiting_for_owner`. The agent can finish its turn. Your matching answer
resumes that call in the same peer session.

You can also ask your foreground agent to check `message_box` with
`type: "inbox"`, provide the answer, and follow the saved question's
`answer_owner` instructions. It can then submit the result for that call.
Provider-tool approval is a separate email question with the provider's exact
options. It remains pending until you choose.

## Retrieve results and inspect progress

Use the returned check continuation, or ask your agent to check the inbox.
Follow `next_cursor` through every page. Calls remain until an accepted result
submission. Results remain across reads and disconnects until the agent sends
the returned receipt. A receipt confirms client processing, not that a human
read the answer.

Outbound items distinguish waiting for permission, submitted work, rejection and
uncertainty. One outstanding intent per target/action pair is allowed. A new
explicit request may replace denied or confirmed-rejected work after correction.
Uncertain work is retained for inspection and never resubmitted automatically.
Central cannot yet recover an accepted request whose response was lost.

## Conversations and diagnostics

Foreground waits return into the initiating conversation. Optional OpenClaw
native return and experimental Claude Code channels have separate configuration
and qualification requirements in [client delivery](client-delivery.md).
Background incoming ACP sessions are separate peer sessions.

At startup Ambassador prints its diagnostics directory. Development logs include
bounded request and response bodies with credentials removed, even without
`--verbose`. Copy the printed directory for investigation. Four files rotate,
each at most 8 MiB. `clean` preserves them. It clears local workflow state but
does not reset central registration or transfer grants to a new identity.
