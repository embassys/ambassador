# Linux ARM64 qualification, September 12

The owner requested Raspberry Pi support under [ADR 0081](adr/0081-linux-arm64-desktop.md).
This candidate is on `codex/people-discovery`, based on main `0bcd106`. It has
not been published and does not change the existing 0.1.2 preview downloads.

## Environment

The package was built natively on ARM64 Debian 12 Bookworm in an isolated
container. The packaged Electron host was exercised separately in an isolated
ARM64 Debian 12 OrbStack machine with an Xvfb display. Both use the host's
`7.0.14-orbstack-00380-ga7e0a2dc9535` Linux kernel. Neither is a Raspberry Pi.
The test machine has no shared host home, provider account or real contacts.

The build keeps Electron 44.2.0, standalone Node 24.19.0 and pnpm 11.22.0.
Dependencies come from the frozen lockfile. Both executable files are Linux
AArch64 ELF binaries; SQLite is rebuilt for the standalone ARM64 Node runtime.

## Checks

- All 45 desktop artifact/render tests and desktop typecheck passed on ARM64.
- All 255 selected desktop, delivery, encrypted-store and message-box regression
  tests passed on ARM64. The updated release-workflow check also passed after
  adding the Linux test libraries to CI.
- Runtime checks passed for the bundled Node version and architecture, SQLite,
  ACP dependency resolution, the actual worker's MCP connection and six tools,
  and registration guidance for an app-owned instance.
- The portable package passed with the source build unavailable and an isolated
  PATH. The extracted archive passed its checksum, inventory and actual MCP
  worker checks.
- The final packaged host passed server startup, duplicate launch, window
  reopening and shutdown. CLI to app to CLI handoff and app restart passed with
  isolated state. The display assertion reproduced the oversized window-icon
  defect before the fix and passed without that diagnostic after rebuilding.

The first regression run used a container without an init process. Its
process-group cancellation test found an unreaped zombie. Running the unchanged
test with Docker's init process passed. A graphical host attempt in that
container stopped at Chromium's sandbox setup check. The separate Linux machine
ran with its normal user-namespace sandbox. No sandbox bypass, root app launch
or host security setting change was used.

The 2048px source icon generated an X11 request of 16,777,248 bytes when opening
the window. The Linux host now resizes its window icon to 256px. The packaged
host test rejects the corresponding X11 diagnostic after reopening the window,
so this is covered by both Linux CI jobs.

Local logs, package inventories and checksums are in `.build/raspberry-pi/`.
The new `ubuntu-24.04-arm` CI job is configured but has not run for this branch.

The final local archive is `Embassys-0.1.2-linux-arm64-development.tar.gz`.
After copying it out of the build environment, its SHA-256 was checked again:
`814c19cd6ce079ba840881157d5d396c98c8980a2972881c342477eb551ddb4c`.
It is a development candidate, not a GitHub release asset.
This archive predates the subsequent borderless People toolbar refinement.

## Remaining device checks

Run the archive on Raspberry Pi 4 or 5 with 64-bit Raspberry Pi OS Desktop.
Check the actual Wayland/X11 desktop, window and tray, login, notifications,
keyring integration, installed providers, and resource use on the device.
Those checks are not implied by a Debian ARM64 package or Xvfb host test.
32-bit Pi OS and a Lite installation without a desktop are outside this target.
Automatic provider setup remains limited to separately qualified platforms.

The accompanying People and empty-sidebar changes passed the native Mac
walkthrough with fictional data. Those screenshots are Mac evidence, not Pi
screenshots. See `.build/people-list-review/screenshots.html`.
