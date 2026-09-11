# Conversation sidebar qualification

The owner approved [ADR 0080](adr/0080-conversation-sidebar.md) on September 11.
Inbox / Requests now holds unlinked requests. All saved conversations appear
below it, with exact linked owner questions first. Settings, service status and
secondary pages remain in the sidebar. The conversation pane displays linked
requests above the saved transcript using the existing fresh owner review.
No general chat composer or central API change was added.

Linkage uses the saved central human-input request ID, its original source
message and the local dispatch session. Private desktop IPC returns bounded
pages of metadata only. The signed-in owner must match the local enrollment.
Missing, conflicting or unavailable associations keep requests in Inbox. The
read is capped at ten pages of 100 local question records; requests beyond this
association window remain visible in Inbox. Paused instances return no links
and never start a server through this read. Retained retired sessions can still
be looked up; forgotten sessions cannot receive linked requests.

Unconfirmed submissions and any corresponding pending request stay together in
Inbox. Sidebar counts deduplicate their kind-qualified IDs. Confirmed answers
trigger a fresh request snapshot. A refresh requested during an existing read
queues one follow-up and discards the old snapshot, preventing an in-flight
pre-answer response from restoring a stale attention badge. Selection follows
the session ID when attention ordering changes. Account/installation changes
invalidate old asynchronous replies and selected history.

Automated evidence:

- Full core suite passed 529 tests with seven expected skips before the final
  refresh refinement. No failures.
- Desktop rendering/artifact suite passed all 33 checks, including sidebar
  structure, exact review choices and attention badges.
- All 17 targeted follow-up checks passed. They cover real session-store lookup through retirement
  and deletion, account identity mismatch, duplicate/conflicting links, unknown
  sessions, pending uncertainty, empty links before enrollment or while stopped,
  and serialized post-decision refresh with disposal of stale replies.
- Desktop typecheck, production build and changed-file lint passed.

Native Mac inspection passed after the owner unlocked the machine. Populated
captures cover light/dark, 840 × 680 and the 680 × 540 minimum, unlinked Inbox,
linked question/transcript, Settings and exact input/permission reviews.
Keyboard arrows selected the exact sample choice. Cancelling left it pending.
Confirming one offline sample answer cleared its badge, returned the conversation
to recent order and kept the same conversation selected. Pausing made the link
unavailable and kept all four requests in Inbox; resuming restored the link.
The permission review was cancelled. These are synthetic UI checks, not new
live central or provider qualification.

The walkthrough found that a Review control could fail to paint on the initial
conversation mount. Giving the row control an explicit stacking position and
centering it fixed the observed display issue. Fresh mounts in light and dark,
including the compact window, passed. Changed-file lint and the production build
passed afterward. Screenshots and evidence are in
`.build/conversation-sidebar-review/screenshots.html`. The sample host was closed;
other app profiles were untouched. The owner-requested temporary keep-awake
remains running with a one-hour timeout. No release was made.


## Compact rows and nested requests

The owner requested smaller conversation rows and individual request rows under
Inbox. Conversations now use one line with a provider label, short identifier
and an attention indicator. The full ID and date remain in the tooltip; the
attention label remains available to accessibility tools. Inbox children show
the requester and request description, or a question prompt. Long text truncates
with the full text in a tooltip. Selecting a child filters the main pane by its
exact kind and ID. Inbox itself opens the full unlinked list.

Unconfirmed submissions remain navigable, including those without a pending
server request, and duplicate pending/uncertain records share one sidebar row.
Selection never falls through to another request after removal. Account or
installation changes clear selection and discard outstanding review replies.
Opening a row does not submit a decision; fresh Review and explicit confirmation
remain required.

All 34 desktop checks and typecheck passed. New regression coverage checks
kind-qualified selection, unknown/removed IDs, uncertainty deduplication and
escaped request labels. Native Mac checks covered populated light/dark screens,
individual selection, returning to Inbox, review cancellation, conversation
selection and the 680 × 540 minimum. An initial Review redraw issue prompted
explicit grid placement for each row element; fresh request and conversation
mounts then displayed the control correctly. The gallery is
`.build/compact-sidebar-review/screenshots.html`. Both isolated sample hosts were
closed. No real account, gateway or provider ran, and no release was made.


## Recognizable conversation rows and detail controls

The owner asked for context beyond provider names and a more finished detail
pane. Rows now show a saved request topic and a verbatim agent excerpt in two
compact lines. A saved request title takes precedence when available. Known
action labels are presentation text only; API action names are unchanged.
Selection still uses the exact session ID. Full provider/session/date metadata
remains in the tooltip, and pending owner work keeps its separate indicator.

Desktop session reads enrich the 100 most recently used sessions from the
existing encrypted archive. Each preview reads at most eight records and 64 KiB.
The topic and excerpt are clipped to 80 and 180 characters without splitting
surrogate pairs. These are starting excerpts, not claims about the latest turn.
No provider is loaded, model called, new content store created or retention
extended. Missing or unreadable previews leave the session visible. Expired
bodies are filtered by the archive before preview derivation. Deleting local
history clears its visible preview and queues a fresh session read, discarding
an older in-flight snapshot. Paused-app session reads use the same archive and
never start the gateway.

A shared disclosure component replaces the default browser presentation in
conversation details, request details, scope details and explanatory sections.
It retains native HTML disclosure keyboard semantics with custom chevrons,
focus treatment, spacing and reduced-motion support. Expanded JSON appears as
labelled fields and nested lists, with exact values and escaped text. Deep data
falls back to formatted text. Permission scope stays expanded in a fresh review;
choices and confirmation behavior are unchanged.

All 36 desktop checks and 19 targeted core checks passed, including retained
archive reads across restart, expiration/deletion, paused desktop session reads,
bounded enrichment, Unicode clipping, uncertain/duplicate request navigation,
exact owner choices and stale read rejection. Desktop typecheck and production
build passed. Changed-file lint has no errors and reports two pre-existing
optional-chain warnings in visible-transcripts.ts.

Native Mac inspection covered populated light/dark views, expanded fields,
keyboard Space toggling, minimum 680 × 540 layout and fresh permission scope.
The sample permission review was cancelled. Captures and evidence are in
`.build/conversation-detail-polish/screenshots.html`. The isolated host used the
production renderer and shared preview function with fictional data. It was
closed afterward. No central/provider qualification or release is claimed.

## Individual requests without an Inbox page

The owner asked to make Inbox work like Conversations in the sidebar. Both are
now headings with matching compact rows. Inbox itself is no longer a navigation
destination. Selecting a request opens only that request, without the aggregate
toolbar or snapshot explanation. Limits remain available on the sidebar heading;
loading, errors and unconfirmed overflow remain visible there.

On launch, the first available unlinked request is selected. With no selection,
the main pane asks the owner to choose a request or conversation. A settled
request keeps its exact kind-qualified key and displays that it is no longer
pending. It does not switch to another approval. Settings and other secondary
pages preserve the selection; Back returns to that request or conversation.
Account or instance changes still discard the old selection. Fresh Review and
explicit confirmation remain required before a decision.

All 37 desktop checks, typecheck and production build passed. Coverage includes
matching sidebar headings, one selected request, exact IDs, uncertainty
deduplication, escaped labels and focused settled/unconfirmed request views.
Native Mac checks verified first-request selection, returning from Settings to
both kinds of selection, a fictional permission decision removing only its own
row, and a settled pane that stayed on that request. Light/dark and minimum
680 × 540 inspection passed; scoped reviews scrolled to all choices, with no
default selected, and cancellation returned to the same request.

Populated captures and evidence are in
`.build/sidebar-workspace-review/screenshots.html`. This was the isolated
production-renderer host with fictional data; the host was closed afterward.
No real account, central mutation, provider exchange or release was involved.

## Chat presentation and stable reading position

The owner requested a chat with identifiable participants, chronological messages,
pending approvals at the bottom and automatic scrolling to recent activity.
Conversation rows now show the peer and topic. Headers show the peer's name and
email when the existing owner communications snapshot matches an archived inbound
message ID under the same enrolled identity. The snapshot remains bounded to 200
communications; missing or conflicting matches fall back to the recorded sender
ID. Unavailable archives use an explicit unknown label. Model text, payload names
and approximate time/name matches never establish peer identity or authorization.

Incoming action calls/results appear on the left; local agent output on the
right. Owner answers and status notifications retain distinct authors. Tool
activity and exact envelopes remain available in disclosures. Pending linked
questions and permissions follow the saved chat, with the existing fresh review,
exact choices and explicit confirmation. A linked question no longer claims its
originating conversation is unavailable.

Private desktop history reads support an exclusive backward cursor over the
existing encrypted group index. Opening reads the latest 50 records with the
existing 512 KiB page bound; it does not scan the whole archive. Earlier pages
prepend, and the renderer retains at most 500 records. Overlapping refreshes
replace updated IDs and retain the existing reading window. Empty/disjoint
snapshots replace old content. Earlier-page reading and the capacity limit pause
automatic refresh until the owner returns to latest. Retention filtering still
applies to every archive read. Neither reading nor scrolling replays a provider
prompt or consumes work.

Native Mac inspection passed populated light/dark views, the 680 × 540 minimum,
participant labels, inline review cancellation and returning from Settings.
A separate long fixture verified latest-first opening, an arriving reply during
scroll-up, jumping to it, earlier-page insertion and returning to recent history.
The first attempt exposed two scroll problems: a sliding newest-page window
dropped an older visible record, and a moving date separator shifted its bubble.
The bounded merge now retains the reading window and scrolling anchors to the
message itself. Before/after captures confirm its position stays unchanged.

All 39 desktop checks and 24 targeted core checks pass. These include role
attribution, chronological tie order, escaped labels, exact peer/owner matching,
identity conflict fallbacks, backward archive pagination without gaps or repeats,
expiration, deletion, stopped-instance reads, bounded refresh merging and stale
read rejection. Typecheck and the production build pass. No dependency or server
contract changed. Galleries and evidence are under
`.build/chat-conversation-review/`; the isolated sample hosts were closed. No
real central/provider exchange or release is claimed.

## Aesthetic finish

The owner accepted the chat structure and asked for a more finished appearance.
The existing sidebar and chat are retained, with a clearer system-font hierarchy,
a neutral selected row, softer incoming bubbles and consistent blue outgoing
bubbles. The white-on-blue message text has a 5.19:1 contrast ratio. Native
controls still use the system accent. Timestamps and disclosure labels are
quieter than the messages. Approval cards have one border, an amber icon,
consistent spacing, full wrapping choices and visible keyboard focus. Expanded
message fields share the bubble surface rather than introducing a white box.

Native Mac inspection found that bottom-following could obscure a review heading
at the minimum window height. The transcript now yields scrolling to an open
review; it also observes the viewport size so resizing a pinned chat keeps its
latest content visible. The native regression procedure was recorded before the
fix. Rechecking confirmed the full heading at 680 × 540, reachable choices and
confirmation, stable position through refresh and choice selection, cancellation,
and bottom-following while expanding and shrinking the window.

All 39 desktop render/artifact/config checks, desktop typecheck, changed-file
format checks and the production build pass. Native checks also cover populated
light/dark conversations, expanded fields, long scope paths, escaped markup,
exact long option labels and keyboard focus. Screenshots and evidence are in
`.build/chat-finish-review/`. Both isolated sample hosts were closed. This pass
does not change account mutations, protocol contracts, dependencies or releases,
and does not qualify a live central or provider exchange.

The subsequent pending-card refinement is scoped to linked conversation requests.
Warm light/dark fills, an amber leading border and icon, stronger request text and
a filled system-accent Review button make the pending decision more visible.
Unlinked Inbox rows and the review/confirmation flow are unchanged. All 39 desktop
checks and the build pass. Native sample checks cover light/dark, 680 × 540, long
questions and review cancellation. Captures are in `.build/pending-request-review/`;
both offline sample hosts were closed.

The owner subsequently rejected the warm card as too bulky. Its replacement is
a flat request row with a fine divider and compact Review button. The colored
panel, leading border and icon tile are removed. Review remains aligned with the
request when details expand. All 39 desktop checks pass, as do native light/dark,
680 × 540, keyboard, details and review/cancel checks. Current captures are in
`.build/minimal-request-review/`; the isolated host was closed.

The flat row was too faint for the owner, who requested light gray, transparency
and a shadow. The current compact row adds a translucent neutral-gray fill,
soft shadow and subtle edge, with an opaque reduced-transparency fallback.
All 39 desktop checks and the production build pass. Native light/dark,
680 × 540 and review/cancel checks passed in the isolated sample host.
Current captures are in `.build/gray-request-review/`; the host was closed.

The owner then removed the redundant "Needs your response" heading and requested
rounder corners and a native-looking Review control. The card now has an 18-pixel
radius; Review uses the shared neutral platform control, compact Mac sizing and
subtle light/dark depth. The request section keeps an accessible name. All 39
desktop checks and typecheck pass. Native light/dark, 680 × 540, keyboard access,
details and review/cancel checks passed. Captures are in
`.build/rounded-request-review/`; the isolated sample host was closed.
