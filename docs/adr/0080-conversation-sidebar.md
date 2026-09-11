# 0080. Conversations with an unlinked request inbox

Status: accepted, September 11, 2026. The owner approved a sidebar containing
Inbox / Requests, followed by Conversations and the individual conversations.
This supersedes ADR 0079's two-tab navigation and sidebar exclusion.

The owner refined this on September 11: individual unlinked requests appear
directly beneath Inbox, and conversation rows use one compact line. Selecting a
request shows that exact kind-qualified request in the main pane. Inbox itself
opens the full unlinked list. Keep unconfirmed submissions visible and preserve
fresh review and explicit confirmation before any decision.

The next refinement replaces provider-only labels with two compact lines: a
topic from saved request data and a short verbatim agent excerpt. Read only the
existing encrypted archive, without loading provider sessions or generating
summaries with a model. Desktop session reads enrich at most the 100 most recent
sessions from eight archive records and 64 KiB per session. Missing, deleted or
expired bodies produce an explicit fallback. Labels never establish peer
identity, request linkage, authorization or action completion. No extra content
store or retention period is introduced. The conversation detail pane uses
consistent styled disclosures with keyboard support and structured fields.

Inbox / Requests contains pending owner requests that cannot be linked to a
saved conversation on the selected installation. All saved conversations appear
below it. Conversations with linked requests needing attention come first;
others follow by recent activity. Selection uses the exact session ID and stays
stable when ordering changes. Show Answer needed or Approval needed, rather than
claiming that every unfinished provider turn requires owner action.

The owner subsequently removed the separate Inbox page. Inbox and Conversations
are matching sidebar headings, with individual selectable rows underneath.
Opening Inbox itself is no longer an action. The first available unlinked
request is selected on opening the workspace; with no request selected, the
main pane asks the owner to choose an item. Selection stays on the same request
after it resolves, rather than automatically switching to another approval.
Requests retain their exact kind-qualified IDs, uncertainty notices and fresh
Review action. Sidebar snapshot limits and errors remain visible.

Opening a conversation shows its saved transcript and related owner requests in
the same pane, using the existing fresh-review and explicit-confirmation flow.
Do not add a general chat composer. Settings, local service status and the
existing secondary pages remain available from the sidebar. Account-first setup
and native application/menu shortcuts remain unchanged.

Link only through recorded identifiers under the same enrolled central identity
as the signed-in owner. The first implementation reads the existing owner
question's central input-request ID and source-message dispatch session through
private desktop IPC. Read bounded pages. Never infer links from names, email,
action type, prompt text, model output or timestamps. Missing, ambiguous, stale,
unavailable or out-of-page associations stay in Inbox / Requests. Owner requests
remain available when the local service is paused; unavailable local links do
not hide them. Unconfirmed submissions remain visible in the request inbox.

No central contract, MCP operation, public CLI option, credential boundary or
provider execution changes. The app reads linkage metadata, without replaying
work or loading provider sessions. Existing exact choices and no-replay markers
remain authoritative. Account snapshots remain bounded and disclose that limit.

Before implementation, cover identity mismatch, duplicate/conflicting links,
missing sessions, kind-qualified IDs, stable ordering and unknown requests.
Inspect populated native screens including linked input, unlinked permissions,
compact size, light/dark, keyboard selection and answering through a fresh review.
Fixture screenshots are explicitly synthetic, not live central qualification.

The owner approved a chat presentation on September 11. Put incoming action
requests/results on the left and the local agent's saved output on the right.
Owner answers and system notifications keep distinct attribution. Show the peer
in the sidebar and header, using exact archived sender/message IDs and matching
inbound owner communications under the same enrollment. Missing or conflicting
identity metadata must stay explicit; prose and payload names cannot identify a
peer. This display does not change authorization or session grouping.

Show messages chronologically, with pending linked reviews after the messages.
Open the latest bounded archive page and allow earlier messages to be loaded
without scanning the complete archive. Initial selection and new activity follow
the bottom, unless the owner has scrolled upward. Preserve their reading position
and provide a jump to latest control. Keep tool activity and exact technical data
available in quiet disclosures. No general message composer is introduced.

The owner accepted the structure and layout and requested an aesthetic finish.
Keep navigation, chronology, attribution, review semantics and scrolling intact.
Refine the system-font hierarchy, sidebar selection, message materials, spacing,
icons and approval controls. Keep exact text, full option labels, keyboard focus,
dark appearance, reduced-motion and high-contrast support. Use the existing
Electron/React stack and CSS; no dependency or protocol change is required.

An open owner review owns its reading position. Bottom-following must not hide
its heading or jump while the owner considers a choice. Resizing a conversation
at the bottom keeps the newest content visible.
