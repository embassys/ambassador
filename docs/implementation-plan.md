# Implementation plan

## Read before working

Read `docs/product-vision-and-architecture.md`, `docs/protocol-v1.md`, this plan, and any accepted decisions in `docs/adr/` that affect your task. If your task conflicts with them, stop and ask. Do not quietly change the scope.

## Rules

- Write the tests and CI setup before production code.
- The first code PR contains tests, fixtures, and CI. It should fail because the product behavior does not exist yet. Keep it off the default branch until implementation makes it pass.
- Do not start production code until the user reviews those failures.
- Do not select or install a runtime, package manager, framework, library, database driver, or build tool without user approval.
- Do not write CLI tests, entrypoints, help text, or command code until the user approves the CLI design.
- Do not add publishing or installation tooling until the user approves the distribution plan.
- A dependency proposal must explain why we need it, the alternatives, the recommendation, its license and maintenance status, and its effect on packaging.
- Agents own separate directories or files where possible. Tasks that share files run sequentially.
- Remote MCP tools, task content, permissions, results, ACP, Grok Bot, and a GUI remain out of scope.

## Before code

| ID | Agent | Task | Depends On | Result |
| --- | --- | --- | --- | --- |
| S1 | Protocol | Draft notification, acknowledgement, wake, retry, and data-boundary behavior without choosing a framework | None | `docs/protocol-v1.md` |
| G0 | User | Review and approve the protocol draft and acceptance cases | S1 | Approved protocol draft |
| R1 | Hermes research | Test native webhook auth, duplicate handling, restart behavior, health checks, and fixed prompts | G0 | Compatibility notes |
| R2 | OpenClaw research | Test session identity, duplicate handling, restart behavior, and immediate wake | G0 | Compatibility notes |
| D1 | Tooling research | Compare the initial tooling options without selecting one | G0 | Options for user review |
| UX1 | CLI design | Draft command names, flags, setup flow, output, errors, config behavior, and noninteractive use without writing code | G0 | CLI designs for user review |
| DIST1 | Distribution research | Compare package registries, standalone files, native installers, package managers, and containers | G0 | Install and publishing options for user review |
| LAB1 | Local test design | Compare host-side and all-container test setups, including controller and runtime networking | G0, R1, R2 | Local test design for user review |
| G1 | User | Approve the tooling, CLI design, distribution direction, local test design, and supported OS matrix | D1, UX1, DIST1, LAB1 | Approved choices recorded in ADRs |

Before `G1`, agents may add docs and research notes only. They may not add project tooling or dependencies.

## Write the failing tests

| ID | Agent | Task | Depends On | Result |
| --- | --- | --- | --- | --- |
| T1 | Testkit | Build a fake controller, fake runtime, deterministic clock, and fault controls | S1, G1 | Tests run without a model or external service |
| T2 | Protocol tests | Cover schemas, versions, authentication, and forbidden content | T1 | Failing protocol tests |
| T3 | Reliability tests | Cover persistence, retries, duplicates, outbox, crashes, restarts, and backpressure | T1 | Failing relay tests |
| T4 | CLI tests | Cover setup, status, doctor, service lifecycle, exit codes, and JSON output | T1 | Failing CLI tests |
| T5 | Adapter tests | Write one adapter contract and apply it to Hermes and OpenClaw | T1, R1, R2 | Failing adapter tests |
| T6 | Local test setup | Build the approved container setup for the controller, OpenClaw, Hermes, and any model stub needed for offline tests | T1, G1, R1, R2 | Reproducible local test environment |
| C1 | CI | Run lint, type checks, tests, security checks, and the OS matrix | G1, T2, T3, T4, T5, T6 | CI shows the expected failures |
| V1 | Test review | Check that each failure comes from missing product behavior, not a bad test or fixture | C1 | Reviewed failure list |
| G2 | User | Review the tests, exclusions, and CI output | V1 | Approval to start production code |

Keep the failing suite on one feature PR. Do not hide failures with `continue-on-error` or skipped tests, and do not merge it while it is red.

Before `G2`, add only tests, fixtures, CI files, and the empty interfaces or entrypoints needed to produce useful failures. Do not implement polling, persistence, adapters, or the daemon.

## Local test setup

Use two container layouts for different jobs.

The main local acceptance test runs the CLI and sidecar on the host. The controller, OpenClaw, Hermes, and an optional fake model run in containers with ports bound to host loopback. This tests the real CLI, host paths, credentials, and network boundary without installing either agent runtime on the host.

The CI layout runs every component in containers on one private network. It is reproducible and good for Linux restart and failure tests, but it does not prove host service installation.

Test `launchd`, `systemd --user`, Windows startup, OS credential storage, and native paths on their actual operating systems. Docker cannot cover those behaviors.

Pin runtime images by version or digest. Do not use moving `latest` tags in CI. The sidecar test suite stops at wake acceptance. A full task claim needs a controller environment that supplies its own MCP endpoint, which remains outside this repository.

## Make the tests pass

| ID | Agent | Task | Depends On | Result |
| --- | --- | --- | --- | --- |
| D2 | Dependency research | Compare options for schema validation, durable storage, HTTP, CLI, logging, and packaging | G2 | Options for user review |
| G3 | User | Approve each production dependency, packaging tool, or standard-library implementation | D2 | Approved choices recorded in ADRs |
| I1 | Protocol | Add only the validation needed to pass T2 | G3 | T2 passes |
| I2 | Storage | Add the approved journal, migrations, state transitions, and outbox | I1 | Storage cases in T3 pass |
| I3 | Relay | Add long polling, acknowledgements, retries, recovery, and backpressure | I2 | The rest of T3 passes |
| I4 | Generic adapter | Add the authenticated webhook adapter | I1 | Shared T5 cases pass |
| I5 | Hermes adapter | Add the behavior supported by the R1 findings | I4 | Hermes T5 cases pass |
| I6 | OpenClaw adapter | Add the behavior supported by the R2 findings | I4 | OpenClaw T5 cases pass |
| I7 | CLI | Add commands, configuration, diagnostics, and foreground daemon mode | I3, I4 | T4 passes except service cases |
| I8 | OS services | Add user-service support for macOS, Linux, and Windows | I7 | All T4 cases pass |

`I5` and `I6` may run in parallel because they own separate adapter directories. Tasks touching shared protocol, storage, or CLI files run sequentially.

## Release checks

| ID | Agent | Task | Depends On | Result |
| --- | --- | --- | --- | --- |
| Q1 | Security review | Check secret handling, authentication, replay protection, local endpoints, and the data boundary | I5, I6, I8 | Findings resolved or accepted |
| Q2 | Reliability | Run crash, cross-platform, soak, upgrade, and migration tests | I5, I6, I8 | Reliability results |
| Q3 | Release | Build signed files, checksums, SBOM, provenance, and clean-machine install tests | Q1, Q2 | Release candidate |
| G4 | User | Review known risks, adapter limits, release files, and docs | Q3 | Approval to release |

## Approval points

Before tests or CI, the user approves the runtime, package manager, test framework, CI provider, lint and formatting strategy, CLI interface, distribution direction, local test setup, and initial operating-system matrix.

Before production code, the user separately approves schema validation, durable storage, HTTP, CLI parsing, logging, secret storage, and packaging choices.

Approval of one dependency never implies approval of later dependencies.
