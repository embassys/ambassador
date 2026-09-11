# Desktop refinement — September 10, 2026

Branch: `codex/desktop-polish-and-people`. This is a development build, not a new
release. [ADR 0078](adr/0078-desktop-polish-and-readable-reviews.md) records scope.

## Changes

- System typography, translucent Mac navigation, consistent spacing and controls,
  focused empty states, simpler welcome and agent setup screens.
- Setup reviews use an in-window sheet. Locations are labelled code fields inside
  a disclosure; tool JSON is formatted in a scrollable block. Exact provider
  options wrap as radio rows above short Cancel/Continue buttons. No option is
  selected by default. Closing, cancellation, expiry and renderer failure cannot
  approve a pending request.
- People supports add, search, edit name, copy email and confirmed removal.
  Selective UTF-8 vCard import keeps names and emails only. It makes no network
  request and sends no invitation. Saved contacts are encrypted and separated by
  account, retained across restart and hidden on sign-out.

## Server review

Central `a8c0e77e0a5bb6897ed842a7288a458124fd298c`, web app
`a9cb3d3b1c9ead3be0f9881cf8ae514a4046dde4` and deployed OpenAPI agree that invitation
acceptance and checking exist, but sending and listing connections are missing.
See [API issue 11](https://github.com/embassys/agent2agent/issues/11). No server
code changed. Local saved contacts are not approved access or verified connections.

## Verification

Boundary tests cover stale/invalid/repeated review answers, exact option IDs,
queue bounds, timeout, abort and cancellation of multiple queued reviews. Render
checks cover escaped remote text, long labels, initially disabled Continue, and
collapsed code details.

People tests cover UTF-8 and folded cards, escaped names, multiple addresses,
case-insensitive duplicates, unsupported encodings, invalid/truncated/oversized
files, rejected extra fields, atomic saves, encrypted storage, account separation,
missing keys, restart, capacity and stale/signed-out owner commands. Local People
operations are tested with all network access failing.

`pnpm run check` passed: 526 tests passed, 7 platform-specific tests skipped,
zero failures. Desktop artifact/render checks passed all 22 tests. Typechecks,
production build, actual bundled Node/SQLite/MCP worker checks and the actual
Electron host startup/duplicate-launch check also passed. The last UI-only
simplification was rebuilt, typechecked and covered by the desktop artifact and
host checks again. Existing lint warnings in unrelated files are unchanged.

## First native Mac walkthrough

The final development app was operated through its actual native window on the
Mac. The existing disposable onboarding account signed in against deployed
central with a real email verification code. The current profile's matching
Claude MCP entry was reused; the temporary discovery skill was installed.

The real Claude agent asked for `get_my_permissions`. Its exact three options
appeared with no default selection and disabled Continue. Choosing its `Yes`
option completed the correlated setup check, and the app showed the verified
account. A second real check was cancelled in the new sheet; no second MCP tool
call was submitted, and the app correctly reported the incomplete check while
keeping settings. Escape also cancelled the connection review before changes.
The formatted request and location disclosures were inspected in the window.

People passed manual add, edit name, search, copy feedback and removal with a
separate confirmation. Native `.vcf` file selection opened the import sheet;
the saved Alex entry was disabled, Sam was selected and saved, and unselected
Jamie was not imported. Restart retained the two saved people and edited name.
Cancelling removal preserved a contact; confirming removal removed only Sam.
Dark appearance and a native tiled/narrow window were inspected. Sign-out
hid the people and returned to onboarding.

A keep-awake assertion was limited to the test process. Both stopped afterward.
The temporary app-owned skill was removed, the original Claude MCP entry was
checked unchanged, and the test verification email was deleted. Verification
codes and imported contacts were absent from both test diagnostic files.
The remaining synthetic contact is retained only in the encrypted disposable
profile. Other installed app profiles were left untouched.

Local screenshot gallery: `.build/ui-refresh-review/screenshots.html`.
Structured evidence: `.build/ui-refresh-review/evidence.json`. These are actual
screenshots, not mockups. They remain local and are not part of the public source.
Windows and Linux native visual testing was not repeated for this refinement.
No release has been published from this branch.

## Follow-up: native sidebar, typography and spacing

The owner found the first pass too similar to a web dashboard. The follow-up
uses a compact Mac source list, grouped navigation and direct access to Agents.
The sidebar no longer repeats the app logo, version and delivery diagnostics.
Instance selection and server status remain at its foot; build information is
available in Device settings.

The Mac theme uses system text at 13 pixels, normal letter spacing, 30-pixel
navigation rows, a 54-pixel window toolbar and smaller controls. The host's
contrast-adjusted accent now reaches the renderer. Inactive window selection
uses a neutral colour. Sidebar vibrancy and native titlebar controls remain.
People fills the content area with a list/detail split. At narrow widths, the
list sits above the detail without a large empty gap. Agent setup uses grouped
rows with short Connect buttons, and manual setup moves below them.

The fixed toolbar and sidebar remain visible while content scrolls. Changing a
page, instance or source resets that content's scroll position. Device settings
uses smaller group padding; review typography and controls follow the same scale.

This follow-up was operated in an isolated Electron profile on the Mac, using
real central owner login. Light and dark appearances, the contact split view,
agent list, narrow window, add-person cancellation, settings scrolling and
connection review disclosures were inspected. Escape cancelled the Claude
connection review before any provider settings changed. The add-person form
was cancelled without saving. Sign-out hid People and returned to onboarding.
The test app was stopped and its verification email deleted. This visual pass
did not repeat the earlier real Claude tool execution or test Windows/Linux.

The updated navigation regression passed with all 22 desktop artifact/render
checks. The production build, typecheck, changed-file lint, bundled worker check
and actual Electron host check passed. No new dependency or release was added.

Local gallery for this earlier pass:
`.build/ui-refresh-review/native-pass/screenshots.html`. Its images are native
app captures. Both galleries above are superseded by the
[simpler Inbox redesign](desktop-simplicity-2026-09-10.md) under ADR 0079.
