# Implementation plan

## Rules

- Read the product document, protocol, this plan, review list, and relevant accepted ADRs before work.
- Write tests, fixtures, and CI before production behavior.
- Keep the first code PR red until the user reviews its failures.
- Do not select or install any framework, library, runtime, package manager, database driver, or build tool before its ADR is explicitly approved.
- Keep MCP bodies out of the relay, journal, normal logs, diagnostics, temporary files, crash artifacts, and support bundles. ADR 0022 permits a temporary development-only stderr transcript.
- Do not preserve the obsolete setup, binding, adapter, configuration, or service interfaces as compatibility code.

## Approved target

ADR `0017-single-webhook-gateway.md` approves:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

One foreground process owns one webhook, one authenticated loopback MCP endpoint, one durable ID stream, and one enrolled central identity. The webhook token authenticates both webhook delivery and local MCP. Verification produces the central JWT; startup does not accept one.

## Documentation

| ID | Task | Result |
| --- | --- | --- |
| D1 | Replace multi-binding architecture and protocol | ADR 0017 and revised product/protocol docs |
| D2 | Remove obsolete ADRs and active-review entries | Only current decisions remain |
| D3 | Record MCP dependency and credential-storage choices | ADRs 0018 and 0019 accepted |
| D4 | Record the independent in-memory central fixture | ADR 0020 |

## Red test PR

Keep all new tests and fixtures on one feature PR. Do not merge it or start production implementation before G1.

| ID | Owner | Task | Depends on | Expected result before implementation |
| --- | --- | --- | --- | --- |
| T1 | Test support | Add loopback fake webhook, raw MCP client, fault controls, secret scanner, and process helpers | D1 | Support code passes |
| T2 | CLI | Test exactly two required `--name=value` options, foreground lifetime, endpoint output, invalid inputs, and singleton ordering | T1 | Fails on legacy CLI |
| T3 | Local MCP | Test loopback bind, bearer authentication, `Host` and `Origin`, MCP lifecycle, limits, deadlines, cancellation, and safe errors | T1 | Fails because no MCP listener exists |
| T4 | Enrollment | Test bootstrap-only catalog, registration forwarding, verification JWT interception, token-free result, tool-list change, persistence failure, restart recovery, and identity replacement rejection | T3 | Fails because enrollment does not exist |
| T5 | Proxy | Test local schemas without `token`, exact transient upstream `token` injection, caller selector rejection, no automatic side-effect retry, and authentication failure behavior | T4 | Fails because proxying does not exist |
| T6 | Relay | Test dormant polling before enrollment, consuming full-message validation, pre-parse amplification limits, memory-only bodies, ID-only durable state, bearer and generic HMAC V2 webhook authentication, no `agentId`, ID-less delivery and races, retries, content acknowledgement, and restart-loss handling | T1, T4 | Fails on legacy controller and binding relay |
| T7 | Central fixture | Build the Dockerized Python/FastMCP in-memory service with deterministic verification and message injection | Approved ADR 0020 | Fixture contract passes independently |
| T8 | End to end | Start gateway, register, verify, prove JWT absence, consume and buffer a message, wake the fake webhook, retrieve content through local MCP, and acknowledge centrally | T2-T7 | Fails on missing gateway behavior |
| C1 | CI | Run unit tests on Linux, macOS, and Windows; build and run Docker E2E on Ubuntu | T1-T8 | Red feature PR with classified failures |
| V1 | Review | Confirm every failure is missing product behavior rather than a fixture defect | C1 | Written failure inventory |
| G1 | User | Review the red suite, fixture contract, proposed MCP SDK, and credential storage | V1 | Approval to implement production behavior |

### Required CLI cases

- Accept `start --webhook-url=<url> --webhook-token-env=<name>` and the temporary development form with `--verbose=true`.
- Accept verbose mode only with the paired development central endpoints. Reject `--verbose`, false or arbitrary values, and duplicates.
- Reject `--webhook-url <url>`, `--webhook-token-env <name>`, positionals, duplicates, unknown options, literal token options, `setup`, `agent`, `run`, configuration paths, and configured local-runtime agent IDs.
- Exit 2 for invalid syntax or option values, 4 for webhook-token resolution failures, and 7 for singleton or local state failures.
- Require the resolved webhook token to contain exactly 192 random bits in `[0-9a-f]{48}` format.
- Acquire the singleton lock before resolving the token or touching credentials.
- Print the endpoint only after successful bind and keep running until cancellation.
- Never print either token or a credential-bearing MCP URL.

### Required enrollment cases

- Authenticate every local call before reading its body.
- Expose only `register_agent`, `verify_email`, and `resend_verification` before enrollment.
- Require structured verification data with exactly one `token` field.
- Persist before returning token-free success or enabling polls.
- Reject concurrent replacement, malformed results, oversized results, and token-bearing registration results.
- After restart, load the JWT through the abstract credential store without exposing it locally.

### Required data scan

Tests scan stdout, stderr, errors, every credential-store artifact, SQLite, WAL, SHM, temporary files, crash artifacts, logs, diagnostics, and support artifacts for known plaintext values:

- webhook token;
- central JWT;
- email and verification code;
- MCP arguments and results; and
- message content and permission data.

ADR 0022 changes the stderr assertion only for explicit verbose tests. Those tests require non-credential request and response content on stderr while still scanning for the webhook token, central JWT, credential headers, and verification code. Every durable artifact remains content-free.

## Production implementation after G1

| ID | Owner | Task | Depends on | Result |
| --- | --- | --- | --- | --- |
| I1 | CLI | Replace command dispatch with the strict two-option foreground `start` | G1 | T2 passes |
| I2 | MCP | Add the approved SDK, authenticated loopback server, central MCP client, limits, and safe errors | G1, approved ADR 0018 | T3 and T5 transport cases pass |
| I3 | Credentials | Implement the approved atomic central JWT store and restart loading | G1, approved ADR 0019 | Abstract credential-store cases pass |
| I4 | Enrollment | Add bootstrap catalog, structured verification interception, sanitization, and identity state | I2, I3 | T4 passes |
| I5 | Relay | Replace binding protocol with one ID stream and one runtime-agnostic authenticated webhook target | I1, I3 | T6 passes |
| I6 | Assembly | Start MCP immediately, gate polling on identity, coordinate shutdown, and stream startup output | I1-I5 | T8 passes |
| I7 | Cleanup | Delete configuration, runtime presets, adapter factory, service manager, obsolete commands, schemas, and tests | I6 | No dead compatibility code remains |
| C2 | CI | Run all checks, audit production dependencies, and run Docker E2E | I7 | Green matrix and E2E |

Shared CLI, application, protocol, journal, and relay files change sequentially. MCP transport and central fixture work may run in parallel because they own separate directories and interfaces.

## Test service

The test service independently implements the remote contract; it does not copy the unlicensed private repository source. It keeps all state and verification delivery in memory.

The container provides:

- Streamable HTTP MCP at `/mcp`;
- registration, verification, resend, message polling, acknowledgement, permission, and action tools;
- `GET /api/poll_messages?timeout=<seconds>` returning and consuming full queued messages;
- no notification acknowledgement endpoint separate from `ack_message`;
- authenticated test-only endpoints to read a verification code by JSON body, inject a message, reset state, and inspect IDs/status flags; and
- health and readiness endpoints.

CI pins the Python base image by digest and Python packages by version and hash. The fixture uses one non-root worker, no volumes, no access log, and no published CI ports. Docker is required only for the Ubuntu E2E job. Unit and integration tests on macOS and Windows use Node loopback fixtures.

## Release checks

| ID | Task | Result |
| --- | --- | --- |
| Q1 | Review local bearer reuse, encrypted credential access, redaction, DNS rebinding protection, and side-effect uncertainty | Findings resolved or accepted |
| Q2 | Run crash, restart, disk-full, credential-corruption, poll-outage, and soak tests | Reliability report |
| Q3 | Pack and install the npm-registry artifact on clean Linux, macOS, and Windows environments | Install qualification |
| G2 | User reviews security findings, dependency audit, central compatibility, and release artifact | Release approval |

## External blockers

- The production central MCP and API URLs are not stable package constants yet.
- The production central API cannot redeliver or retrieve delivered but unacknowledged messages after a gateway restart, so development compatibility uses a bounded in-memory inbox with an explicit crash-loss limitation.
- The current central MCP wrapper returns Python string representations. ADR 0021 permits bounded, non-executing normalization as a temporary compatibility measure; native structured results remain preferred.
- The central service has no token reissue path. A crash after remote verification succeeds but before local credential persistence would strand the identity.
- Docker is available in GitHub's Ubuntu runner and on the local acceptance-test host.
