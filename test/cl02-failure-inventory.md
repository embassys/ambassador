# CL02 reviewed failure inventory

Review date: 2026-08-31

The selected-interface suite contains 30 top-level nodes across seven files.
Three fake-interface and loader guards pass. L01 through L27 each fail at one
exact missing CL03 production boundary, with no infrastructure failure,
timeout, skip, or todo. No Claude executable, credential, account, or provider
history was used.

| File | Green nodes | Reviewed red nodes |
| --- | ---: | --- |
| `cl02-fixture-integrity.test.js` | 2 | none |
| `cl02-loader-boundary.test.js` | 1 | L23 |
| `cl02-monitor-containment.test.js` | 0 | L24-L27 |
| `cl02-process-lifecycle.test.js` | 0 | L15-L19 |
| `cl02-security-integration.test.js` | 0 | L20-L22 |
| `cl02-startup-session.test.js` | 0 | L01-L08 |
| `cl02-stream-contract.test.js` | 0 | L09-L14 |

Each red marker is `[CL02-CL03:Lnn] CL03 Claude Code adapter production
boundary is absent`, where `nn` matches the test ID. The shared structured
runner verifies the exact filename, nesting, name, directive state, marker,
and totals: 30 tests, 3 pass, 27 fail, 0 skipped, and 0 todo.

The review rejected the first draft because several node names claimed more
coverage than their bodies proved. The amended suite makes these cases
explicit:

- L15 selects all 13 ADR 0035 owner-death barriers. Connector-side barriers
  block through a private callback. Monitor-side start parsing and spawn
  barriers block inside the six-pipe fake monitor. The parent kills the real
  adapter owner and checks the recorded monitor process group until signal 0
  reports `ESRCH`.
- L17 covers cancellation before init, after session publication, during the
  stdin write, after replay, after a terminal candidate, and after child exit.
  L18 covers normal exit, prompt EOF with a live descendant, cancellation, and
  provider `SIGINT`, `SIGTERM`, and `SIGKILL` exits.
- L24 sends malformed, missing, duplicate, unknown, oversized, over-depth,
  excess-count, excess-byte, and out-of-order control. It also checks wrong
  executable and argument shapes, invalid exit pairs, false group claims,
  monitor faults, and owner, command, and lifecycle pipe closure.
- L20 runs a marked turn through the connector and fake gateway, scans runtime
  state and SQLite, working and temporary directories, raw launch captures,
  build and stage trees, a packed tarball's clean installation, and the packed
  connector checker. It rejects prompt, reply, tool, approval, credential,
  provider-history, diagnostic, fixture, and private test-control bytes.
- L01 and L05 through L14 now include the previously missing timeout, signal,
  overflow, malformed resume, exact depth, exact record, stdout, stderr,
  event-count, progress, ID, reply, and absolute-deadline boundaries.

This inventory authorizes CL03 implementation only. It is not real-provider
qualification evidence and makes no provider or platform support claim.
