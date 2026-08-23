# Implementation status

Status as of August 23, 2026.

## Complete on the feature branch

- Strict controller, wake, and configuration schemas.
- Secure controller client with fixed v1 paths, bearer authentication, redirect rejection, bounded responses, operation deadlines, and controller retry semantics.
- SQLite journal with atomic ingestion, durable acknowledgements and reports, queue capacity, atomic claims, crash recovery, conservative clock-offset handling, private regular-file enforcement, and terminal states.
- Relay polling, wake dispatch, retry timing, expiry, duplicate normalization, bounded outbox replay, report-outage backpressure, and in-process recovery.
- Generic HMAC webhook adapter.
- Best-effort Hermes and OpenClaw adapters for the pinned researched contracts.
- Foreground daemon assembly with atomic crash-releasing one-instance locking and signal-based shutdown.
- CLI setup, agent management, health tests, status, diagnostics, foreground run, JSON output, and stable exit codes.
- Per-user service definitions and lifecycle commands for `launchd`, `systemd --user`, and Windows Task Scheduler, including native restart-after-failure policies.
- Linux, macOS, and Windows CI configuration.
- 133 automated tests using local HTTP servers, real temporary SQLite files, and concurrent subprocess lock contention.
- Exact Node 24.19.0 and npm 11.19.0 checks, build, coverage, native SQLite loading, and production dependency audit pass locally.

## Partially complete

- Runtime qualification has request and response contract tests, but not pinned real-runtime container runs.
- Service lifecycle has command and file tests on all platforms, but native login-start tests have not run in CI yet.
- The application integration test uses a real controller HTTP boundary and generic runtime HTTP boundary, but both are in-process fixtures rather than reusable containers.
- The cross-platform GitHub Actions workflow has not run remotely because this repository has no configured Git remote.
- Distribution has an approved direction and service definitions, but no standalone archive builder, checksum generation, signing, notarization, SBOM, or package-manager manifests.

## Required before public beta

- Add OS credential-vault support. Environment references are acceptable for development but fragile in graphical login sessions.
- Define controller-managed credential issuance and refresh.
- Qualify pinned OpenClaw and Hermes images with a fake model, including a runtime restart between duplicate wake attempts. Keep both presets labeled best-effort unless their duplicate state becomes durable.
- Run native `launchd`, `systemd --user`, and Task Scheduler tests on clean machines.
- Add migration, abrupt-process-exit, disk-full, and long-running soak tests.
- Select and record the standalone archive tool, supported architecture matrix, and Linux libc baseline.
- Produce signed artifacts, checksums, an SBOM, provenance, and clean-machine install tests.
- Define bounded journal retention after every adapter has an explicit duplicate window.

No package or release artifact should be published until these items pass review.
