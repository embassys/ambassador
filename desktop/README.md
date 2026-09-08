# Embassys desktop development

This private workspace implements the desktop app approved in
[ADR 0064](../docs/adr/0064-desktop-application.md). For a ready-made development
download, see the [installation guide](../docs/desktop-install.md). The app and
its matching bundled CLI share one installation under ADR 0069. Additional
instances stay isolated; credential import and migration remain outside scope.

## Build and run

From the repository root with the approved Node/pnpm toolchain:

```sh
pnpm install --frozen-lockfile
pnpm --filter @embassys/desktop run typecheck
pnpm --filter @embassys/desktop run build
pnpm --filter @embassys/desktop run verify
pnpm --filter @embassys/desktop run verify:host
pnpm --filter @embassys/desktop run start
```

`build` downloads official Node 24.19.0 and verifies its published SHA-256,
creates an isolated deployment of the lockfile-resolved engine, rebuilds SQLite
under that runtime, and bundles the Electron main, preload and React renderer.
There are no launch-time runtime downloads. Use `package` to create an unsigned
local app under `.build/desktop/packages`. Nothing is published or installed in
Applications automatically.

`verify` starts the actual bundled gateway with an isolated executable path,
opens its SQLite library and checks a real MCP initialization. Native desktop
checks are separate; a package probe is not evidence of a displayed window.
`verify:host` launches the real Electron host with a temporary profile, verifies
its server and duplicate-launch behavior, then checks shutdown. It observes
server availability, not the contents or appearance of a window. After packaging,
run `verify:package` to repeat the check against the packaged application binary.

## What this stage implements

- A sandboxed window, tray menu and separate Node gateway processes.
- Automatic start for enabled instances. Stop persists across app restarts.
- Named instances with separate ports, private storage, process ownership and
  diagnostics. The first instance uses port 8787. An occupied port produces an
  error; it does not stop the process using it.
- Explicit Stop and Clean controls. Clean confirms in a native dialog and
  retains the state lock during identity and work-count review. It preserves logs and provider configuration.
- Account-first login and registration, owner approval and answer controls,
  permission review and revocation through existing central APIs.
- Reviewed agent connection helpers on qualified platforms, with existing
  connections preserved and manual guidance elsewhere.
- Encrypted visible conversation archives and labelled
  provider history previews. Bodies are retained for 30 days within a 1 GiB cap.
- Searchable, paged diagnostics with native export preview/save and folder reveal.
- Native storage-location selection, bounded worker restart and opt-in startup
  settings. Startup remains unavailable in the unsigned Mac preview.
- Workers release idle resources; the Mac packaged host has an automated
  background resource gate.

Central recovery, complete history, one-code signup and native remote push
remain API follow-ups. Alternative engine versions, signed distribution,
automatic updates and further native platform/provider qualification remain in
the [implementation plan](../docs/desktop-app-plan.md).

## Boundaries

The renderer receives no credentials and cannot execute a command or select an
arbitrary filesystem path. A bounded, versioned IPC protocol connects the window
to the host and the host to each worker. Each worker retains the existing
loopback MCP, encrypted state, singleton lock and central delivery protections.

Closing the window is intended to leave the tray and servers active. Quitting
stops the owned workers. Native Mac behavior has been qualified; Windows and
Linux native window/tray and provider behavior still need qualification.
