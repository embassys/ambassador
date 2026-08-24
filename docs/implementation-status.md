# Implementation status

Status as of August 24, 2026.

## Complete on main

- Strict controller, wake, and configuration schemas.
- Secure controller client with fixed v1 paths, bearer authentication, redirect rejection, bounded responses, operation deadlines, and controller retry semantics.
- SQLite journal with atomic ingestion, durable acknowledgements and reports, queue capacity, atomic claims, crash recovery, conservative clock-offset handling, private single-link SQLite artifacts, and terminal states.
- Relay polling, wake dispatch, retry timing, expiry, duplicate normalization, bounded outbox replay, report-outage backpressure, and in-process recovery.
- Generic HMAC webhook adapter.
- Best-effort Hermes and OpenClaw adapters for the pinned researched contracts.
- Foreground daemon assembly with atomic crash-releasing one-instance locking and signal-based shutdown.
- CLI setup, agent management, health tests, status, diagnostics, foreground run, JSON output, and stable exit codes.
- Per-user service definitions and lifecycle commands for `launchd`, `systemd --user`, and Windows Task Scheduler, including native restart-after-failure policies.
- Linux, macOS, and Windows CI checks passing on GitHub Actions.
- 142 automated tests using local HTTP servers, real temporary SQLite files, and concurrent subprocess lock contention.
- Exact Node 24.19.0 and npm 11.19.0 checks, build, coverage, native SQLite loading, and production dependency audit pass locally.
- Public `@a2adev/gateway@0.1.0` npm package with the `a2a-gateway` executable, MIT license, and Node 24 engine requirement.
- Packed-install and executable-link smoke tests, plus a public-registry `npx @a2adev/gateway version` check.
- Main-branch npm publishing workflow with GitHub OIDC permissions and an already-published-version check.

## Partially complete

- Runtime qualification has request and response contract tests, but not pinned real-runtime container runs.
- Service lifecycle has command and file tests on all platforms, but native login-start tests have not run in CI yet.
- The application integration test uses a real controller HTTP boundary and generic runtime HTTP boundary, but both are in-process fixtures rather than reusable containers.
- npm trusted publishing is configured for `nikrooz/a2a` and `.github/workflows/cli.yml`, but has not published a version yet. Version `0.1.0` was already present when the first main-branch publish job ran, so that job skipped `npm publish`.
- The GitHub repository is private. npm trusted publishing works for private repositories, but npm provenance requires public source.
- The public package has been installed and run on macOS, but not from clean Linux and Windows user environments.

## Required before public beta

- Add OS credential-vault support. Environment references are acceptable for development but fragile in graphical login sessions.
- Define controller-managed credential issuance and refresh.
- Qualify pinned OpenClaw and Hermes images with a fake model, including a runtime restart between duplicate wake attempts. Keep both presets labeled best-effort unless their duplicate state becomes durable.
- Run native `launchd`, `systemd --user`, and Task Scheduler tests on clean machines.
- Add migration, abrupt-process-exit, disk-full, and long-running soak tests.
- Qualify global npm installation and native `better-sqlite3` loading on each supported operating system without elevation.
- Complete one new-version publish through GitHub OIDC. Produce an SBOM, and decide whether public npm provenance requires making the source repository public before beta.
- Define bounded journal retention after every adapter has an explicit duplicate window.

The published `0.1.0` package is a development preview, not a public-beta approval.
