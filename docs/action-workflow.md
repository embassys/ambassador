# Request and answer an action

Keep Ambassador running and register through your configured agent first.
Both people use their own enrolled identity and decide permissions by email.

## Request something from another identity

Tell your agent what you want, who should receive the request, and the actual
request details. For example: **Ask alex@example.com for their phone number so
we can arrange tomorrow's meeting. Send the request when they approve it.**

The agent checks `list_action_types`, then calls `request_permission` with the
target address, action name, and exact request object as `action_payload`:

```json
{
  "target_email": "alex@example.com",
  "action_type": "get_phone_number",
  "decision_options": "once_always",
  "reason": "Arrange tomorrow's meeting",
  "action_payload": { "reason": "Arrange tomorrow's meeting" }
}
```

Ambassador saves that intent encrypted. Alex receives the permission email.
When Alex grants permission, Ambassador submits the saved payload once. An
existing grant allows immediate submission. Your agent should not make a second
`call_action` for this saved intent.

If you only want permission for future work, omit `action_payload`. A later
permission grant then reports status. It does not create an action request.

## Answer an incoming action

Your configured delivery agent receives the request. If it has enough
information, it submits a structured success or error with `submit_action_result`
and the original `call_id`. If it needs your input, the call remains encrypted
in Ambassador's inbox across restarts.

Ask **Check my Embassys inbox**, provide the missing information, and have your
agent submit the result for that call. A separate provider tool approval may
also arrive at your own email address while the agent is working.

## Retrieve the answer or inspect progress

Ask **Check my Embassys inbox** in any configured agent chat. The agent follows
`next_cursor` until it has read all pages. Calls remain until their result is
accepted; returned results leave after a successful inbox read. Outbound items
show whether permission is pending, the request was submitted, or the outcome
is uncertain. A later explicit permission request can replace a denied outbound item.

Ambassador keeps one outstanding saved intent per target/action pair. Repeating
the same request returns its status; it cannot silently replace the payload.
An uncertain request is kept for inspection and is never automatically resent.
If its status is `ready`, repeating the identical request safely continues the
saved dispatch after a restart.

## Context and retention

Direct delivery reuses a provider session for the same remote agent identity,
within your enrollment, provider, and working directory. Every action keeps its
own completion state. The registration chat remains separate; the inbox connects
it to later delivery work.

The provider manages model context and compaction. Ambassador does not treat a
summary as an action result. Sessions with no unfinished work become eligible
for cleanup after 30 idle days. Unanswered calls and unread results do not expire
automatically. Each encrypted store has a 1 GiB quota, while pages and individual
records stay small enough to read without loading the whole database.
