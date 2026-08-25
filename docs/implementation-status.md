# Implementation status

Status as of August 25, 2026.

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

## Approved design, not implemented

- ADR `0016-combined-gateway-mcp-proxy.md` approves one process for ID-only notification relay, runtime wake delivery, and authenticated local MCP proxying in the short and medium term.
- The target process will hold one central agent JWT reference per binding and inject it into upstream MCP calls. Agents will not pass central JWTs as tool arguments.
- The provisional central mapping uses one JWT-authenticated `/api/poll_messages` stream per binding and assumes each returned message contains only an opaque `id`.
- The current `0.1.0` package has no MCP listener, MCP tools, per-binding central JWT configuration, or local caller authentication.
- Every G5 decision in `docs/implementation-plan.md`, including ID scope, poll isolation, tool catalog, JWT lifecycle, side-effect semantics, transport, authentication, configuration, CLI, dependencies, and migration behavior, requires another user review before tests or implementation.

## Partially complete

- Runtime qualification has request and response contract tests, but not pinned real-runtime container runs.
- Service lifecycle has command and file tests on all platforms, but native login-start tests have not run in CI yet.
- The application integration test uses a real controller HTTP boundary and generic runtime HTTP boundary, but both are in-process fixtures rather than reusable containers.
- The current controller client still uses ADR 0003's superseded `/v1/sidecar/...` development paths. It does not implement ADR 0016's per-binding polling compatibility mapping.
- The inspected central `poll_messages` implementation marks messages delivered during polling and lacks redelivery, idempotent acknowledgement, expiry metadata, and wake reporting, so it does not satisfy the durable relay contract yet.
- npm trusted publishing is configured for `nikrooz/a2a` and `.github/workflows/cli.yml`, but has not published a version yet. Version `0.1.0` was already present when the first main-branch publish job ran, so that job skipped `npm publish`.
- The GitHub repository is private. npm trusted publishing works for private repositories, but npm provenance requires public source.
- The public package has been installed and run on macOS, but not from clean Linux and Windows user environments.

## Required before public beta

- Approve and implement loopback MCP transport, local caller authentication, fixed caller-to-binding mapping, payload limits, and cancellation behavior.
- Approve the per-binding central JWT reference shape, then add OS credential-vault support. The current relay's environment references are development-only and do not pre-approve the combined-process configuration.
- Define central agent JWT enrollment, issuance, refresh, revocation, and reissue without returning JWTs through local MCP tools, plus migration to a future restricted gateway credential.
- Add durable controller redelivery, idempotent persistence acknowledgement, expiry metadata, and wake reporting around the available polling API.
- Prove cross-binding JWT isolation and prove that MCP tool arguments and responses never enter configuration, SQLite, diagnostics, metrics, or logs.
- Qualify pinned OpenClaw and Hermes images with a fake model, including a runtime restart between duplicate wake attempts. Keep both presets labeled best-effort unless their duplicate state becomes durable.
- Run native `launchd`, `systemd --user`, and Task Scheduler tests on clean machines.
- Add migration, abrupt-process-exit, disk-full, and long-running soak tests.
- Qualify global npm installation and native `better-sqlite3` loading on each supported operating system without elevation.
- Complete one new-version publish through GitHub OIDC. Produce an SBOM, and decide whether public npm provenance requires making the source repository public before beta.
- Define bounded journal retention after every adapter has an explicit duplicate window.

The published `0.1.0` package is a relay-only development preview. It does not contain the approved combined MCP proxy and is not a public-beta approval.
