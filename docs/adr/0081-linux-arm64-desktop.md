# 0081. Linux ARM64 desktop for Raspberry Pi

Status: accepted, September 12, 2026. The owner requested that the Linux app
also run on Raspberry Pi.

Add a native Linux ARM64 build to the existing desktop package pipeline. Target
64-bit Raspberry Pi OS with a graphical desktop, initially Debian Bookworm or
Trixie on a Pi 4 or Pi 5. The desktop must use the matching Linux ARM64 Electron,
bundled Node and SQLite native module. Keep the existing Electron 44.2.0,
Node 24.19.0, pnpm and locked dependencies; no new runtime or cross-compilation
toolchain is introduced. Other 64-bit Pi models have not been qualified. A
32-bit operating system and Pi OS Lite without a desktop are outside this target.

The existing build runs its bundled Node to rebuild SQLite. Build on an ARM64
Linux machine or VM instead of renaming an x64 package or cross-packaging Mac
native dependencies. Extend CI with the native ubuntu-24.04-arm runner. Run the
same worker, encrypted-store, portability, extracted archive, host lifecycle and
CLI handoff checks. Name the archive and evidence with linux-arm64, and assert
both platform and architecture during runtime verification. Sandbox helper paths
must follow the actual build architecture. Never disable Chromium's sandbox or
relax system security settings for testing or installation.

Keep provider configuration qualification independent. Raspberry Pi gets the
existing manual provider guidance until installed-agent flows are qualified on
that platform. Do not claim Pi graphics, tray, keyring, notifications or provider
behavior from Ubuntu ARM64 tests alone. Record the exact environment and checks.
No central API change, release publication or replacement of existing preview
assets is authorized by this request.

References checked September 12:

- [Raspberry Pi OS editions and architectures](https://www.raspberrypi.com/documentation/computers/os.html)
- [Electron 44.2.0 ARM64 release assets](https://github.com/electron/electron/releases/tag/v44.2.0)
- [Node 24.19.0 platform requirements](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md)
- [GitHub ARM64 runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
