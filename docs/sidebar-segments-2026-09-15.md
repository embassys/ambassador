# Sidebar segments, September 15

The owner requested an Inbox / Conversations / People segmented control and
Settings and service status beside the Embassys logo.

Each segment shows only its own sidebar content. Inbox retains individual
requests, Conversations retains peer sessions and attention markers, and People
offers Saved people, Connected and Invitations. The main People view keeps its
existing contact actions. Its former second tab row is removed.

Settings and the service indicator now sit beside the brand. The indicator opens
service settings and distinguishes Running, Paused, transitional states and
Needs attention. The installation name remains available in its tooltip. Agents
and Access remain in the adjacent More menu.

The segment control stays above the scrolling list. It supports Left, Right,
Home and End with a single tab stop. The Inbox count remains visible while
another segment is selected. Switching sections preserves the selected request,
conversation and People view; Back from Settings returns to that section.

Validation:

- All 48 desktop render/artifact checks passed, including section isolation,
  inbox counts, empty states, selected requests and accessible status controls.
- Desktop typecheck, lint and the development build passed.
- Native Mac computer-control checks passed section switching, arrow and End
  keys, request selection retention, all People views, Settings and Back.
  Pause and Resume updated the header status to Paused and Running.
- Populated Inbox, Conversations and People screens were inspected in the native
  app. Dark conversation styling was also checked. A clipped Running label was
  corrected before the final screenshots.

Screenshots are in `.build/sidebar-segments-review/`. They use controlled sample
data in the actual Electron renderer. These UI checks do not replace the live
account qualification still recorded in
[the account-history test report](account-history-and-mac-test-2026-09-15.md).

No dependency, API, public CLI, credential, retention or release policy changed.

## Back control and softer corners

The owner requested removing the visible Back label and slightly rounder
controls. Back now uses a chevron in a button 30 pixels wide and 28 pixels tall.
The owner requested the slightly shorter height after reviewing it. Its destination remains
in the tooltip and accessibility label, and its disabled state is unchanged.
Buttons, sidebar rows, segments, detail sheets, chat bubbles and request cards
have slightly softer corners.

All 49 desktop render/artifact checks passed, including the icon-only Back
control's accessible label and disabled state. Native Mac checks confirmed
that the Settings chevron returns to the selected request. Populated Settings
and conversation screenshots are in `.build/friendly-controls-review/`.

The owner clarified that the height reduction applies across the app. Action
buttons, secondary controls, menu items, segments, People actions and detail
triggers now have slightly less vertical padding. Platform button sizes are
reduced too; typography, horizontal padding and focus treatment are preserved.
Multi-line content and exact provider options still wrap without a fixed height.

## Request review dialogs

The owner approved opening Review in a dialog over the selected request or
conversation. The request card remains mounted. Opening a review no longer
scrolls the account view into position or replaces its content.

The modal keeps the request identity and response options visible. Technical
action fields and exact scope open through Request details. Nested Escape closes
only those details and preserves the selected choice. Cancel and Escape close
the review without submitting, restore the original scroll position and return
focus to Review. While a submission is pending, dismissal and duplicate
submission are disabled. Confirmation closes the modal and updates the request
in the same view. If its button has disappeared, focus returns to the account
container; it cannot move focus or scroll into another page or a newer dialog.

All 53 desktop checks passed, including modal focus/scroll lifecycle tests,
removed or disabled triggers, exact choices and no default approval. Typecheck,
lint and the development build passed. Native Mac checks covered a permission,
a conversation question, Cancel, Escape, nested details, preserved choice,
confirmation in the same conversation and long questions/options with a
reachable footer. The sample-data screenshots are in
`.build/request-dialog-review/`; these checks do not submit to central.
