# Ambassador desktop development

This private workspace implements the first stage of
[ADR 0064](../docs/adr/0064-desktop-application.md). The public npm CLI is unchanged.

## Build and run

From the repository root with the approved Node/pnpm toolchain:

```sh
pnpm install --frozen-lockfile
pnpm --filter @embassys/ambassador-desktop run typecheck
pnpm --filter @embassys/ambassador-desktop run build
pnpm --filter @embassys/ambassador-desktop run verify
pnpm --filter @embassys/ambassador-desktop run verify:host
pnpm --filter @embassys/ambassador-desktop run start
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
  requires the state lock. It preserves logs and provider configuration.
- Manual setup guidance, existing managed-session queries and bounded provider
  history previews, plus recent redacted diagnostic records.

App sign-in, the owner inbox, permission decisions and push delivery depend on
central contracts in issues 7–10. Their screens disclose that they are unavailable.
Automatic connection, CLI import, transcript archiving, log export, alternative
engine versions, location selection and update/install integration remain in the
[implementation plan](../docs/desktop-app-plan.md).

## Boundaries

The renderer receives no credentials and cannot execute a command or select an
arbitrary filesystem path. A bounded, versioned IPC protocol connects the window
to the host and the host to each worker. Each worker retains the existing
loopback MCP, encrypted state, singleton lock and central delivery protections.

Closing the window is intended to leave the tray and servers active. Quitting
stops the owned workers. Native window/tray behavior and provider process cleanup
still require installed-app qualification on macOS, Linux and Windows.
