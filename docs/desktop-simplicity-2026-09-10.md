# Simpler desktop app — September 10, 2026

Branch: `codex/desktop-polish-and-people`. The owner asked to simplify the app
after the visual refinement. [ADR 0079](adr/0079-simple-desktop-inbox.md) records
the direction. This build has not been released.

## Everyday flow

The main window opens Inbox, with History beside it. It has no sidebar. More
opens People, Connect agents and Access; Settings has a visible toolbar button.
Each secondary screen has Back to Inbox. Login and guided connection still
precede the main app.

Inbox combines owner permission requests and questions chronologically. Each
has one Review action. The review reads fresh server data and preserves the
exact scope and options. Unknown menus cannot be approved. Unconfirmed
submissions stay visible even when the returned pending list is empty.
Snapshot limits and the last refresh time are in About this inbox.

History shows saved agent conversations for the selected installation. Settings
contains local-service controls, account, notifications and appearance. Its Advanced disclosure contains
instance selection, server controls, registration, local work, local permissions,
network events and logs. Owner and local records remain separate. A stopped
server gets a visible Resume action in Inbox.

Connect agents has one Connect button per provider. Test, repair, disconnect and
manual instructions remain under Options. Destructive and provider changes keep
their existing review. The compact window defaults to 760 × 620 with a minimum
of 680 × 540, using system typography, native window controls and light/dark
appearance. No dependency, API or credential/delivery behavior changed.

## Verification

The tests were updated before implementation. All 24 desktop artifact and render
tests passed, including the two-view navigation, secondary menu, combined request
order and unchanged kind/ID/payload identity, uncertain submissions, escaped
remote text, exact approval choices, unknown-menu refusal and sign-out gating.
Desktop typechecking, production build, changed-file lint and whitespace checks
passed. The bundled Node/SQLite/MCP worker and actual Electron host startup and
duplicate-launch checks passed.

The actual development app was operated in the existing isolated test profile
on macOS. Owner login used deployed central. The first walkthrough checked:

- Inbox, History, People, Access, Connect agents and Settings navigation.
- More dismissal and keyboard navigation, and Back to Inbox.
- Light and dark appearance, the 680 × 540 minimum window, and the final
  760 × 620 launch size.
- Connection review and Escape cancellation, including the minimum window.
  No provider settings were changed by these cancelled reviews.
- Server Stop, the Inbox paused notice, and Resume returning it to running.
- Restart from History returning to Inbox with the existing owner session.
- The encrypted test contact surviving restart and the revised People layout.
- Sign-out hiding account data and returning to the welcome screen, then Quit.

The test verification email was deleted. The isolated test app and temporary
keep-awake process were stopped; other app profiles were untouched.

The live account had no pending requests or saved conversations. Populated
request rendering and exact review choices are covered by deterministic tests;
this walkthrough did not create new owner approvals, repeat real-agent action
execution, or qualify Windows/Linux. Earlier full core and real Claude evidence
remains in the [refinement record](desktop-refinement-2026-09-10.md).

The current native screenshots are listed in
`.build/simple-app-review/screenshots.html`. Build and test logs are beside it.
These local artifacts are not part of the public source. Earlier sidebar
galleries show superseded designs.

## Follow-up: visible Settings and local status

The owner requested a more native feel, discoverable Settings and visible running
state. Settings now has a labelled toolbar button before and after login, plus
native application and tray menu entries. Command-comma on Mac and Control-comma
elsewhere open it. A compact status strip identifies the selected installation
and local worker state. Worker notices/errors show Needs attention; running is
not a central-connectivity or provider-readiness claim.

Settings puts Background service and Pause/Resume above account preferences.
Advanced keeps ports, storage, instances and diagnostic controls. The Mac host
uses under-window material and a 52-pixel toolbar with aligned native window
controls. Compact system text, grouped preferences, a notification switch and
a simpler welcome screen replace the larger presentation. The main content
remains React-rendered in Electron; no platform widget toolkit was added.

All 26 desktop artifact/render checks and five appearance tests passed, as did
the production build, desktop typecheck, changed-file lint and whitespace checks.
The bundled worker and actual Electron host probes passed. Added regressions
cover all local runtime states, notices/errors on a running worker, settings
visibility, the signed-out header and the native menu shortcut/callback.

The actual Mac app passed the labelled Settings button, status-strip navigation,
native application-menu entry and Command-comma before and after restart.
Pause showed Paused in Settings and Inbox; Resume showed Starting then Running.
The notification switch changed state and was restored. Light/dark and minimum
680 × 540 layouts were inspected. A consumed Settings request did not reopen
after a renderer reload. Opening Settings before login exposed a stale page;
Back to setup now restores Inbox, and a second deployed-central login verified
the fix. Sign-out hid account data while keeping local status visible.

Both test verification emails were deleted. The isolated app was signed out and
closed; the temporary keep-awake process was stopped. Provider configuration
and other installed app profiles were untouched. This pass did not execute a
new provider action or repeat native Windows/Linux qualification.

Current captures: `.build/native-status-review/screenshots.html`. The earlier
simple-app gallery has the version where Settings was still inside More.

## Follow-up: 1Password and Linear references

The owner preferred the typography, spacing and desktop character of 1Password
and Linear. The reference material was the official
[1Password Mac overview](https://support.1password.com/getting-started-mac/) and
[Linear's March 2026 design refresh](https://linear.app/now/behind-the-latest-design-refresh).
The implementation keeps Inbox/History and the visible Settings button, with
neutral Mac surfaces, quieter request icons, consistent spacing and aligned
preferences separated by fine rules. Owner reviews now lead with the request,
then labelled identity, exact action name, expiry and scope. Missing reason or
conversation context remains visible. Radio labels are unchanged and wrap; no
choice is selected automatically. Connection and provider sheets use compact
headings, wrapped technical details and a persistent action bar.

A regression test was added before the review markup changed. All 27 desktop
render/artifact tests passed, including missing context, exact choices, escaped
remote values, unknown menu refusal and disabled confirmation before selection.
Desktop typecheck, the production build, changed-file lint and whitespace checks
passed. No API, dependency, credential or delivery change was made.

The actual Mac app was inspected in the isolated onboarding test profile. Login
used deployed central. Light/dark Settings, the visible button and Command-comma,
680 × 540 and 760 × 620 layouts, Pause/Resume, Inbox and connection review all
passed. Expanded paths scrolled above the fixed action bar. Escape cancelled
both reviews without changing provider settings. The live account had no pending
owner requests; populated owner review and request-list coverage in this pass
is deterministic rendering, not a new live approval exchange. Native Windows
and Linux qualification was not repeated.

Screenshots are in `.build/linear-refinement/screenshots.html`. The test account
was signed out, its verification email deleted, and the test app and temporary
keep-awake process stopped. Appearance was restored to dark and notifications
remained off. Other installed app profiles were untouched. No release was made.

## Follow-up: page details and populated screenshots

The owner clarified that the remaining concern was polish inside pages and
asked for Inbox and History screenshots containing items. This pass keeps the
navigation. Inbox rows have compact sender/request/date hierarchy, restrained
icons, fine separators and consistent controls. Reviews use a bounded reading
width, wrapped code and paths, exact full radio labels and short confirmation
buttons. Opening a review resets its scroll position and focuses the review,
including when the originating Inbox was scrolled.

History now has readable provider names, date/time and a short identifier in
its list. Full IDs remain in tooltips and Details; the current session API does
not supply peer names or summaries. Transcript headings, timestamps, text and
technical disclosures have separate visual roles. The list and transcript
scroll independently, with context and pagination controls remaining visible.
Turn finished describes a provider turn only. Partial history and interrupted
turns remain explicit. A failed session load clears the old content and offers
Try again, fixing the possibility of showing the previous session's transcript
under a new selection.

The isolated [visual host](../desktop/scripts/visual/README.md) runs the actual
production renderer and preload in Electron, with four fictional requests and
saved conversations. It uses no real account, central calls, gateway or provider.
The visible installation label identifies sample data. Native Mac checks covered
populated Inbox and History, exact answer selection with keyboard controls,
light/dark appearance, minimum 680 × 540 sizing, independent transcript scroll,
partial and unavailable history, long labels, escaped markup, wrapped paths,
unknown-menu refusal and review focus/scroll after navigating a scrolled list.
No sample approval was submitted. The test host and temporary keep-awake process
were stopped; other app profiles were untouched.

Five new rendering/schema regressions bring the desktop artifact suite to 32
checks. They cover exact IDs, selected rows, escaped transcript content,
turn-versus-action status, loading/failed content, partial/provider qualifications
and the visual fixture's deployed request shape. Final build and check results
are recorded with the local screenshot gallery at
`.build/page-detail-review/screenshots.html`. This pass does not repeat live
central/provider exchanges or native Windows/Linux qualification. No release
was made.
