# CI and local platform testing

[ADR 0084](adr/0084-shared-core-and-platform-ci.md) replaces repeated full flow
suites with one shared core and native component checks on each build target.
It does not reduce the scenarios covered by the shared tests.

| Check | Where it runs | Coverage |
| --- | --- | --- |
| Shared core | Ubuntu x64, once | Registration, permission and action flows, recovery, cancellation, long waits, owner controls, provider fixtures, UI state, lint and types |
| Desktop rendering | Same core job | All desktop artifact and view tests, plus desktop types |
| Native components | macOS, Windows, Ubuntu x64 and ARM64 | Real P-256 keys, encrypted key reload, private file modes/DACLs, symlinks/junctions, SQLite recovery files, singleton contention and crash recovery |
| Installed npm package | All four targets | Native SQLite ABI and installed command; full fixture flow only on Ubuntu x64 |
| Independent central fixture | Ubuntu x64 | Python REST fixture and installed Ambassador interoperability |
| Desktop package | All four targets | Bundled runtime, archives and checksums, portable dependency loading, native host startup, duplicate launch and shutdown |
| Complete platform flows | Local only | All tests, installed-package flows, desktop packaging, CLI/app handoff and Mac resource measurement |

PR updates cancel obsolete runs of that PR. Main runs keep their publication
gates. Desktop no longer runs a second copy for every `codex/` branch push when
the same commit already has a PR. Neither native failures nor audit failures are
optional. CI does not qualify real third-party providers or native remote push.

## Development commands

Use the repository's pinned Node 24.19.0 and pnpm 11.22.0, then install with
`pnpm install --frozen-lockfile`.

```sh
pnpm check:core       # Shared flows, lint and types
pnpm test:platform    # Actual host's isolated native checks
pnpm test             # Both suites; preserves the full local test command
```

After compilation, inspect the selection with
`node scripts/run-tests.mjs --suite=core --list` or `--suite=platform --list`.
Tests under `test/platform/` enter every native CI job automatically. Other
current `.test.ts` files enter core automatically, including nested directories.
The existing retired `t03-` tests remain excluded. Script-runner regression tests
also run in core. Invalid or empty selections fail.

Keep algorithms and business scenarios in core, including injected OS error
paths. Put a test in `test/platform/` when its assertion depends on the real OS,
filesystem, cryptography, native module or child process. Exercise that boundary
directly instead of reenrolling an agent for each native check.

## Full local qualification

Run one of these on its named OS, or use `pnpm qualify:platform` on any supported
host. The aliases reject a different host; they do not emulate it.

```sh
pnpm qualify:macos
pnpm qualify:windows
pnpm qualify:linux
```

These commands refuse CI. They run the complete checks, install a fresh tarball
outside the repository, run its fixture flows, build and check the desktop
archives, launch the packaged host and exercise CLI → app → CLI handoff. macOS
also measures the packaged host's resource use. Each stage records duration and
success in `.build/platform-qualification/<platform>-<arch>.json`; failure stops
the run. The temporary installation is removed afterward.

The desktop checks use disposable profiles. Port 8787 must be free for the
existing handoff check; it refuses to stop an existing server. Package builds
replace `.build/desktop` build outputs. The scripts use fixture identities and
do not register production accounts or change installed provider configuration.

Linux needs the desktop libraries listed in `.github/workflows/desktop.yml`
and a graphical session. On a headless machine use
`xvfb-run -a pnpm qualify:linux`. Electron's sandbox must be available, either
through the host's supported user namespaces or the packaged `chrome-sandbox`
helper with root ownership and mode 4755. The qualifier never disables the
sandbox or changes system permissions for you. Linux ARM64 is qualified by its
native CI runner; this does not certify every Raspberry Pi distribution.

Real-agent and deployed-central tests remain separate:
`pnpm qualify:agents` and `pnpm qualify:live`, following their existing setup and
authorization instructions in [delivery qualification](qualification.md).

## Timing evidence

Before this change, [core run 34879335350](https://github.com/embassys/ambassador/actions/runs/34879335350)
took 42m44s on Windows, with 40m56s in `pnpm check`.
[Desktop run 34879335515](https://github.com/embassys/ambassador/actions/runs/34879335515)
took 28m44s on Windows, including 23m18s repeating desktop and business tests.
The comparable shared Linux check took 2m24s. These are completed run timings,
not timeout estimates. New run timings will be recorded after CI qualification.
