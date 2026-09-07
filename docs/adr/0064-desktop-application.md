# 0064 Desktop application and isolated instances

Status: accepted

Date: 2026-09-07

## Approval

The user approved all recommendations in the desktop design and implementation
plan, asked to push the documents to main, and authorized implementation. This
approves the Electron shell with a bundled Node gateway, desktop setup helpers,
isolated instances, owner sign-in and decisions through new central contracts,
visible conversation archiving and desktop packaging. The later scope amendment
below removes the initially proposed CLI import.
It does not authorize central code changes or a release.

The accepted detail is in [Desktop app design](../desktop-app-design.md) and
[Desktop app plan](../desktop-app-plan.md). Implementation status stays in the
[work plan](../implementation-plan.md); API changes remain issue-only.

## Product name and fresh app state

On 2026-09-07 the user named the desktop app **Embassys** and confirmed that it
replaces the CLI experience. CLI import, credential transfer and state migration
are out of scope. Create fresh app-owned instances and leave existing CLI and
older development-app data untouched. Do not implement a compatibility reader
or an import screen. Unsupported state versions fail closed.

The private workspace is `@embassys/desktop`. Development packages use the
Embassys app and executable name, with `com.embassys.desktop.development` as the
OS identity. The existing gateway package and fixed `ambassador` MCP entry remain
internal integration names; this does not rename a published release or grant
permission to publish one.

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

This amends the previous GUI prohibition and provider-history persistence rule
only as specified by the accepted desktop plan. Migration remains out of scope. The public CLI
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

## Guarded Claude Code setup

The first automatic connection helper uses Claude Code's supported
`mcp add-json --scope user` command with the fixed `ambassador` entry and a
660000 ms per-server timeout. A native review names the selected instance,
loopback address and user-wide scope. It does not select the incoming executor,
register an identity, restart Claude or approve provider tools.

Validate the existing configuration before offering a change. Refuse malformed,
linked, oversized or conflicting configuration and never replace an existing
entry. A matching entry needs no write. Recheck the reviewed file before invoking
Claude and inspect the saved entry after the command, including a lost response.
Discard command output. Configuration success is separate from a connected
client or tested executor. The connection ownership extension below now covers
Claude Code and OpenClaw; Codex and Hermes remain manual until their safe
configuration helpers and installed-client tests are complete.

This follows the [Claude Code MCP setup and timeout contract](https://code.claude.com/docs/en/mcp).
The installed CLI preserved the timeout and refused a duplicate entry in an
isolated temporary profile on 2026-09-07. No dependency was added.


Native Quit uses a separate cleanup state. Further quit requests remain prevented
until workers and setup commands settle. Final termination runs on the next event
loop turn so an already-resolved cleanup cannot re-enter the same Cocoa terminate
callback. Failed cleanup restores the controls and reports an error.

## Platform appearance and connection ownership

On 2026-09-07 the user requested further implementation, a more polished native
appearance and app-driven end-to-end qualification, and supplied a blue/purple
logo reference. Use a repository-owned vector interpretation and packaged Mac,
Windows and Linux icons. No additional UI framework is needed: the approved
Electron shell provides native window controls, Mac sidebar vibrancy and Windows
Mica, with ordinary Linux window decorations. System fonts, platform spacing,
keyboard conventions, high contrast and reduced transparency remain explicit.
Light, dark and system appearance are local app preferences.

Connection changes use a five-minute review tied to the selected instance,
provider configuration and its fingerprint. Keep a separate public-data-only
ownership journal before invoking the provider's fixed setup command. Check
the saved entry after success or a lost response; never automatically repeat
the command. Repair restores a missing app-owned entry. Disconnect removes only
the unchanged entry the app created. A matching pre-existing entry remains
unowned; a changed entry or another instance's binding gets manual guidance.
App Clean preserves connection ownership and provider settings.

Claude Code uses its user-scope add/remove commands. OpenClaw uses create-only
`mcp add` with a 660-second timeout and its `unset` command. An explicit absolute
OpenClaw configuration path binds setup to that exact profile. Unsupported
profile resolution or JSON5 settings remain manual until validated parsing is
available. Checking settings does not prove a model connection or conversation
return. The app never restarts a provider as a side effect of configuration.

Automatic connection commands are enabled only for a natively qualified platform.
The initial qualification is macOS arm64 with installed Claude Code and OpenClaw.
Other systems retain manual instructions until their installed-client tests pass;
compiling the app on CI does not enable a configuration adapter. In particular,
Windows npm command shims need a reviewed native launch path before qualification.
