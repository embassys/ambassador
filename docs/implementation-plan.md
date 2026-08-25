# Implementation plan

## Rules

- Read the product document, protocol, this plan, review list, and relevant accepted ADRs before work.
- Write tests, fixtures, and CI before production behavior.
- Keep the first code PR red until the user reviews its failures.
- Do not install a production framework or library before its ADR is approved.
- Keep MCP bodies out of the relay, journal, logs, diagnostics, temporary files, crash artifacts, and support bundles.
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
| D3 | Record MCP dependency and credential-storage choices | ADRs 0018 and 0019 await explicit approval |
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
| T6 | Relay | Test dormant polling before enrollment, ID-only poll validation, commit-before-`ack_notification`, bearer webhook, no `agentId`, retries, separate content acknowledgement, and restart | T1, T4 | Fails on legacy controller and binding relay |
| T7 | Central fixture | Build the Dockerized Python/FastMCP in-memory service with deterministic verification and message injection | ADR 0020 | Fixture contract passes independently |
| T8 | End to end | Start gateway, register, verify, scan out JWT, poll an ID, wake fake webhook, retrieve content through MCP, and acknowledge | T2-T7 | Fails on missing gateway behavior |
| C1 | CI | Run unit tests on Linux, macOS, and Windows; build and run Docker E2E on Ubuntu | T1-T8 | Red feature PR with classified failures |
| V1 | Review | Confirm every failure is missing product behavior rather than a fixture defect | C1 | Written failure inventory |
| G1 | User | Review the red suite, fixture contract, proposed MCP SDK, and credential storage | V1 | Approval to implement production behavior |

### Required CLI cases

- Accept only `start --webhook-url=<url> --webhook-token-env=<name>`.
- Reject `--webhook-url <url>`, `--webhook-token-env <name>`, positionals, duplicates, unknown options, literal token options, `setup`, `agent`, `run`, configuration paths, and agent IDs.
- Acquire the singleton lock before resolving the token or touching credentials.
- Print the endpoint only after successful bind and keep running until cancellation.
- Never print either token or a credential-bearing MCP URL.

### Required enrollment cases

- Authenticate every local call before reading its body.
- Expose only `register_agent`, `verify_email`, and `resend_verification` before enrollment.
- Require structured verification data with exactly one `token` field.
- Persist before returning token-free success or enabling polls.
- Reject concurrent replacement, malformed results, oversized results, and token-bearing registration results.
- After restart, decrypt and load the stored JWT without exposing it locally.

### Required data scan

Tests scan stdout, stderr, errors, SQLite, WAL, SHM, state files other than approved encrypted credential ciphertext, logs, diagnostics, and support artifacts for:

- webhook token;
- central JWT;
- email and verification code;
- MCP arguments and results; and
- message content and permission data.

## Production implementation after G1

| ID | Owner | Task | Depends on | Result |
| --- | --- | --- | --- | --- |
| I1 | CLI | Replace command dispatch with the strict two-option foreground `start` | G1 | T2 passes |
| I2 | MCP | Add the approved SDK, authenticated loopback server, central MCP client, limits, and safe errors | G1, approved ADR 0018 | T3 and T5 transport cases pass |
| I3 | Credentials | Implement the approved atomic central JWT store and restart loading | G1, approved ADR 0019 | T4 persistence cases pass |
| I4 | Enrollment | Add bootstrap catalog, structured verification interception, sanitization, and identity state | I2, I3 | T4 passes |
| I5 | Relay | Replace binding protocol with one ID stream and one bearer webhook target | I1, I3 | T6 passes |
| I6 | Assembly | Start MCP immediately, gate polling on identity, coordinate shutdown, and stream startup output | I1-I5 | T8 passes |
| I7 | Cleanup | Delete configuration, runtime presets, adapter factory, service manager, obsolete commands, schemas, and tests | I6 | No dead compatibility code remains |
| C2 | CI | Run all checks, audit production dependencies, and run Docker E2E | I7 | Green matrix and E2E |

Shared CLI, application, protocol, journal, and relay files change sequentially. MCP transport and central fixture work may run in parallel because they own separate directories and interfaces.

## Test service

The test service independently implements the remote contract; it does not copy the unlicensed private repository source. It keeps all state and verification delivery in memory.

The container provides:

- Streamable HTTP MCP at `/mcp`;
- registration, verification, resend, message polling, acknowledgement, permission, and action tools;
- `GET /api/poll_messages?timeout=<seconds>&view=ids` for non-consuming ID notifications;
- idempotent `POST /api/ack_notification` for relay persistence without consuming MCP content;
- authenticated test-only endpoints to read a verification code by JSON body, inject a message, reset state, and inspect IDs/status flags; and
- health and readiness endpoints.

CI pins the Python base image by digest and Python packages by version and hash. The fixture uses one non-root worker, no volumes, no access log, and no published CI ports. Docker is required only for the Ubuntu E2E job. Unit and integration tests on macOS and Windows use Node loopback fixtures.

## Release checks

| ID | Task | Result |
| --- | --- | --- |
| Q1 | Review local bearer reuse, encrypted credential access, redaction, DNS rebinding protection, and side-effect uncertainty | Findings resolved or accepted |
| Q2 | Run crash, restart, disk-full, credential-corruption, poll-outage, and soak tests | Reliability report |
| Q3 | Pack and install the npm artifact on clean Linux, macOS, and Windows environments | Install qualification |
| G2 | User reviews security findings, dependency audit, central compatibility, and release artifact | Release approval |

## External blockers

- The production central MCP and API URLs are not stable package constants yet.
- The production central API lacks the non-consuming ID view and separate idempotent notification acknowledgement required by this protocol.
- The current central MCP wrapper returns Python string representations instead of structured verification data, so safe JWT extraction requires an upstream contract change.
- The central service has no token reissue path. A crash after remote verification succeeds but before local credential persistence would strand the identity.
- Docker is available in GitHub's Ubuntu runner, but the local Docker daemon is not running on this machine.
