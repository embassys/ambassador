# 0078. Desktop polish and readable approval sheets

Status: accepted, 2026-09-10, following the owner's request to improve the app's
visual quality and replace dense approval dialogs, paths and long buttons.

Keep Electron and React. On Mac, use native neutral surfaces and the system
accent; retain the current palette on other platforms. Refine typography,
spacing, navigation, onboarding and empty states around a shared set of controls.
Retain native window decorations, Mac sidebar vibrancy, Windows/Linux treatment,
keyboard operation, dark appearance and reduced-motion/transparency fallbacks.
No new framework, font service or component dependency is needed.

The owner requested a further native refinement of sidebar, typography and
spacing on September 10. Use a compact grouped source list with direct Agents
navigation, a fixed 54-pixel toolbar, 13-pixel system body text and 30-pixel Mac
navigation rows. Remove the repeated sidebar brand and move build information to
settings. Respect the host accent and inactive-window selection. People uses the
full content area with a list/detail split; agent setup uses grouped rows. Page
contents scroll independently of the toolbar and sidebar. Keep transparent Mac
sidebar material and opaque/reduced-transparency fallbacks.

Replace setup confirmation and provider-approval message boxes with a modal
sheet rendered by the existing sandboxed local window. The host creates each
bounded review with an unpredictable ID and retains the valid response choices.
The renderer can answer only the current review through validated private IPC.
Setup-provider requests retain the existing worker guard and abort signal.
Timeout, closing the window, renderer failure and Quit cancel pending reviews.
No selection is made by default. A stale, unknown or repeated response cannot
approve a different request.

Show connection locations as labelled, wrapped code fields in expandable setup
details. Show a provider's exact option labels as selectable rows, followed by
short Cancel and Continue buttons. Return the original option ID unchanged;
do not shorten a label in a way that changes its scope or map provider choices.
Tool details remain available as escaped, formatted data in a disclosure. Only
reviewed exact tool names receive a fixed plain-language explanation.

This does not change central human-input approval, ordinary tool waits, owner
authentication, credentials, API contracts or CLI behavior. Write boundary tests first, add rendering coverage, then repeat the native
approval and onboarding walkthrough. No release is authorized by this change.

## People and contact import

The user's request includes adding people and contact integration where supported.
Review of central `a8c0e77`, web app `a9cb3d3`, and deployed OpenAPI on September 10
found invitation acceptance and status checking, but no exposed send-invitation
or owner contact-list route. Track those in
[API issue 11](https://github.com/embassys/agent2agent/issues/11); do not invent
routes or use permission requests as invitations.

Implement a local People list as the independent part of this request. It offers
manual add, edit name, remove, search and copy email. A native file picker imports
selected names and literal email addresses from UTF-8 vCard 3/4 files. Nothing is
selected by default; saving a contact never sends an invitation or grants access.
The screen explicitly distinguishes saved people from server connections.

Use the existing encrypted record store in `account/people.sqlite`, bound to the
signed-in account's central agent ID. The renderer cannot choose that ID. A new
owner context discards old rendered data and queued commands. Local reads and
writes need a locally signed-in account but do not refresh its remote session:
this address book works offline. Sign-out hides it; signing back into the same
account restores it. Clean preserves account data. Remove deletes that saved
contact, without changing messages or permissions. There is no cloud sync or
expiry for saved contacts. Names and addresses do not enter diagnostic logs.

Bound each file to 1 MiB and 1,000 cards/addresses, each save to 25 selected
contacts, and each account to 500 contacts. Each normalized contact is at most
900 UTF-8 JSON bytes. One encrypted account record makes import atomic; it fits
the existing 512 KiB record limit. Reject malformed file framing and skip cards
with unsupported legacy encodings or no usable email. Ignore phone numbers,
notes, photos and addresses. Never fetch embedded URLs. Case-normalized duplicate
emails retain the existing saved name; only explicit Edit name replaces it.
No native address-book entitlement, dependency or central upload is introduced.
