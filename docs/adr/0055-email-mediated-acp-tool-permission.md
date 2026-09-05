# 0055 Email-mediated ACP tool permission

Status: accepted; receipt capture and buffering amended by ADR 0056

Date: 2026-09-04

## Problem

A direct agent can ask its ACP client for permission before executing a local
tool. ADR 0050 temporarily made Ambassador approve those requests
automatically so unattended delivery could proceed. That gives a remote
message a path to provider-configured tools without a human decision and is
not the intended product boundary.

Embassys now has an asynchronous own-human input flow. The authenticated agent
submits a question correlated to a central message, its owner answers by email,
and central returns the answer to that same agent through `poll_messages`.

## Decision

Replace automatic ACP approval with the central email flow:

1. Keep the ACP `session/request_permission` request open.
2. Submit `POST /api/get_human_input` with the triggering central `message_id`.
   The recipient always comes from the authenticated agent's own record; the
   message ID supplies correlation and proves the agent is a party.
3. Use the fixed internal type `ambassador_acp_tool_execution` and the two
   buttons `Allow once` and `Deny`. Send only the fixed profile and a bounded
   tool title or kind in the question. Never send raw tool input.
4. Poll `GET /api/poll_messages?timeout=0` until the correlated
   `human_input_response` arrives. Match its `request_id`, source `message_id`,
   fixed action type, prompt, input type, and selected value. Do not poll the
   separate status endpoint.
5. Map a positive human decision to the ACP `allow_once` option when offered,
   falling back to an advertised positive option. Map denial to an advertised
   rejection option. If the required polarity is unavailable, cancel the ACP
   request.

Human response time does not count against the normal prompt or outer delivery
deadline. Shutdown still cancels the wait and closes the provider process.

The approval poll may receive unrelated central messages. Ambassador keeps at
most 256 complete messages and 16 MiB in memory. It first encrypts eligible
action calls and results at receipt, then drains the queue in arrival order in
batches of at most 512 KiB after the current ACP turn. The correlated response is
an internal control message: it is not prompted into the provider as a second
business message. It still passes through the ID-only journal and is
acknowledged only after the current delivery completes and the ACP permission
response has been selected.

The REST mapping is isolated in the central permission coordinator. The normal
MCP `request_permission` tool remains the separate Embassys resource-permission
operation described by ADR 0054; `get_human_input` is not exposed as a general
MCP tool.

Webhook receivers own their provider permission flow. Ambassador performs this
ACP mediation only in direct mode.

## Consequences

An unattended direct turn can remain open for a long human delay, and normal
delivery for that identity waits behind it. No local dialog or foreground chat
is required. Existing consuming-poll restart loss remains: if Ambassador exits
after central marks a message delivered but before local completion, central
does not redeliver its body.

The current server auto-creates the fixed internal name as one unverified
action type with an empty schema. Ambassador hides that exact name, plus the
legacy generated internal names from pre-cutover live runs, before validating
the public action catalog. A reviewed reserved type would be cleaner and is
tracked as central follow-up work.

## Superseded decision

This record supersedes ADR 0050's automatic positive ACP permission policy. It
does not change provider-configured MCP and built-in tools, authentication,
persistent ACP sessions, or session inspection.

## Approval

The user replaced automatic ACP approval with central email approval and
confirmed that the asynchronous decision must be consumed from
`poll_messages` on 2026-09-04.
