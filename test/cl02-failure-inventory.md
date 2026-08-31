# CL02 implementation inventory

Review date: 2026-08-31

The selected-interface suite contains 30 top-level nodes across seven files.
After the reviewed CL02 red phase, CL03 makes all 30 nodes pass with no skip or
todo. No real Claude executable, credential, account, or provider history is
used.

| File | Green nodes |
| --- | ---: |
| `cl02-fixture-integrity.test.js` | 2 |
| `cl02-loader-boundary.test.js` | 2 |
| `cl02-monitor-containment.test.js` | 4 |
| `cl02-process-lifecycle.test.js` | 5 |
| `cl02-security-integration.test.js` | 3 |
| `cl02-startup-session.test.js` | 8 |
| `cl02-stream-contract.test.js` | 6 |

The shared structured runner verifies the exact filename, nesting, name,
directive state, and totals: 30 tests, 30 pass, 0 fail, 0 skipped, and 0 todo.

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

This inventory is fake-provider implementation evidence only. It is not
real-provider qualification evidence and makes no provider support claim.
