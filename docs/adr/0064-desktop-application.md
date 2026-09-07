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
