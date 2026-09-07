# 0064 Desktop application and isolated instances

Status: accepted

Date: 2026-09-07

## Approval

The user approved all recommendations in the desktop design and implementation
plan, asked to push the documents to main, and authorized implementation. This
approves the Electron shell with a bundled Node gateway, desktop setup helpers,
isolated instances, owner sign-in and decisions through new central contracts,
visible conversation archiving, deliberate CLI import, and desktop packaging.
It does not authorize central code changes or a release.

The accepted detail is in [Desktop app design](../desktop-app-design.md) and
[Desktop app plan](../desktop-app-plan.md). Implementation status stays in the
[work plan](../implementation-plan.md); API changes remain issue-only.

## Decision

Use a tray/menu-bar host and a sandboxed management window. Reuse the existing
TypeScript engine in a separate process running a bundled, qualified Node build.
Keep owner account credentials and events separate from agent execution
credentials and custody. Expose bounded typed private IPC, never an owner-control
MCP tool or renderer filesystem/shell access.

Closing a window keeps background work running; quitting stops all app-owned
work. An intentional server stop is persisted and never triggers automatic
restart. Clean remains local and requires exclusive ownership of the stopped
instance. Do not stop unrelated processes or mutate provider configuration during
Clean. New instances isolate ports, canonical locations, credentials, locks,
workflow state, logs and provider endpoint bindings.

The app's owner sign-in must not impersonate an MCP client to select delivery.
An owner selects a reviewed fixed executor. Owner decisions need central owner
authentication and one atomic transaction shared with email. Missing server
features remain unavailable and labelled; no speculative routes, fake success or
agent-token fallback is allowed.

Retain visible Ambassador-managed conversation bodies for 30 days with a 1 GiB
per-instance cap, and settled activity/audit cache for 90 days. Never archive
private reasoning or evict unresolved workflow custody to free transcript space.
Old or unavailable provider history is labelled. Production diagnostics still
need an explicit retention policy before a production release; the approved
development body logging and credential redaction continue during development.

Use resumable owner events for running-app notifications and separately qualify
APNs/Windows push. Neither notification acceptance nor a window read consumes
the agent's unread result. Linux retains running-app delivery and email fallback.

## Implementation boundaries

This amends the previous GUI prohibition, provider-history persistence rule and
no-migration rule only as specified by the accepted desktop plan. The public CLI
retains its existing commands and flags until an exact CLI change is approved.
All current credential, fixed-provider, exact-action, uncertainty and independent
receiver protections remain in force.

Electron and the proposed TypeScript component UI are approved choices. Record
exact implementation dependencies and packaging decisions as they are qualified.
Use the existing runtime, SQLite and test infrastructure where possible. Desktop
build dependencies stay outside the public CLI's production dependency graph.

Write boundary tests before implementation. Cross-platform compilation and mock
tests do not qualify a real desktop/provider combination. Signed installers,
native OS behavior and central owner/recovery contracts remain release gates.

## Initial desktop build choices

The private desktop workspace uses Electron 44.2.0, React/React DOM 19.2.8,
esbuild 0.28.2 and Electron Packager 20.3.0. React type packages are development
only. These implement the approved shell and component UI; they do not change
the CLI's production dependencies or public package. Existing pnpm release-age
and build-script restrictions still apply. Builds record the standalone Node
runtime version and engine digest. Local packaging downloads official Node 24.19.0 at build time and verifies its
SHA-256 against Node's published manifest. It rebuilds SQLite under that runtime
and tests the worker with an isolated executable path. The deployment workspace
is separate from the source checkout. Production distribution still needs
signed components and native qualification of the complete runtime matrix.

## Desktop service implementation

The renderer submits only typed instance IDs and bounded query fields. Native
file dialogs select export and storage paths in the host. Exports prepare a
five-minute immutable preview, omit bodies by default, redact credentials again,
and create a new owner-only file. They never upload. Clean acquires the stopped
instance's lock for the entire identity/count review and confirmation, with a
five-minute cancellation deadline. Cancel leaves the instance stopped.

Visible transcripts use the existing authenticated encrypted record format in a
separate `ambassador-visible-transcripts` scope. New stores can opt into HMAC
session/turn group indexes for bounded pages and retention work. Existing custody
schemas stay unchanged. Active and settled turn indexes separate recovery and
retention from body reads. The archive has its own 1 GiB quota and fixed-size gap
notice; archive failure does not block the receiver or consume workflow results.
Only live visible text and tool titles/statuses enter capture. Provider replay is
excluded, and private thought events are excluded from both capture and direct
update diagnostics. Bodies expire after 30 days; gap metadata expires after 90.
Reads and local-history deletion never submit an agent receipt or delete provider
history. Old history is a labelled provider preview when available.

The host retries an unexpectedly exited gateway at 2, 8 and 30 seconds, then
requires a manual restart. It starts the gateway using saved state; it never
replays the IPC command that lost its response. Intentional stop cancels recovery.
Linux package directories omit spaces because the tested Ubuntu sandbox launcher
split the executable path. The development CI provisions only its bundled
`chrome-sandbox` helper with the required ownership/mode and keeps sandboxing on.

Stopped and failed-start workers exit after their read or failed start finishes.
A Clean review retains its worker and exclusive lock until confirmation or
cancellation, including while the window refreshes diagnostics. Missing identity
credentials alongside encrypted work prevent a zero-count Clean preview.

Desktop credential stores use the same scrypt parameters and encrypted envelope
as the CLI. Derivation runs in a short-lived child of the bundled Node worker so
the operating system releases its temporary native allocation. The fixed helper
accepts one 24-byte wrapping key and 16-byte salt over private binary IPC, returns
one 32-byte derived key, then exits. Calls are serialized with an eight-request
bound and a 15-second deadline. Nothing is written to a temporary file or log;
parent disconnect terminates the helper. The CLI retains in-process derivation.

GUI workers put the bundled Node directory first in a bounded absolute PATH,
preserve existing absolute entries, and add reviewed user/system install
locations. They never load login-shell configuration or add the current directory.
Windows environment-key casing is normalized. Provider commands, capability
selection and authentication policies remain unchanged.

Launch at login is an explicit app preference. Windows uses Electron's fixed
executable/argument registration and checks the exact registry item, including
OS startup approval. Linux creates one app-owned Desktop Entry with an exclusive
atomic link, and refuses to replace or remove an externally changed entry. It
uses the Freedesktop Exec escaping rules without a shell. macOS uses the main
app service only after distribution is signed and notarized; this unsigned
preview leaves the control unavailable. A login launch opens the background host;
normal launch or a later activation opens the window. No public CLI flag changed.
See the [Electron login-item contract](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)
and [Desktop Entry specification](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html).
