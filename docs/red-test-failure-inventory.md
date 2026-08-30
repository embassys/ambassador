# Red test failure inventory

Status: awaiting user review

Date: 2026-08-25

## Local Node run

`npm test` compiles the production and test TypeScript, then runs 151 tests.

| Result | Count |
| --- | --- |
| Pass | 143 |
| Fail | 8 |

The 142 legacy tests still pass. The dependency-free central contract test also passes.

## CI matrix

This table records the historical 2026-08-25 run. Its Windows row is not a
current CI lane or support claim; ADR 0033 later made Windows unsupported for
the initial release.

| Job | Pass | Fail | Skip | Classification |
| --- | ---: | ---: | ---: | --- |
| Ubuntu Node | 143 | 8 | 0 | Expected red failures only |
| macOS Node | 143 | 8 | 0 | Expected red failures only |
| Windows Node | 136 | 8 | 7 | Expected red failures plus existing platform skips |
| Ubuntu Docker fixture | 8 | 0 | 0 | Passing fixture contract and hardened runtime health |

## Expected failures

| Test | Current failure | Missing behavior |
| --- | --- | --- |
| Removed setup | Legacy `setup` exits 0 | Reject removed configuration commands with exit 2 |
| Removed agent management | Legacy `agent list` exits 0 | Reject removed binding commands with exit 2 |
| Invalid startup forms | Missing token environment exits 2 | Parse the new options, then classify credential resolution as exit 4 without reflection |
| Full enrollment and relay | New `start` exits 2 | Foreground MCP, enrollment, persistence, polling, wake, retrieval, acknowledgement, and restart |
| Malformed verification | New `start` exits 2 | Fail-closed verification-result validation without polling or JWT disclosure |
| Credential-store failure | New `start` exits 2 | Persist before local success and leave polling dormant on failure |
| Webhook retry | New `start` exits 2 | Retry the same opaque ID after a failed wake |
| Executable lifecycle | Packaged CLI exits before startup | Real foreground process, singleton ordering, and graceful `SIGTERM` |

Later assertions in these tests also lock local bearer checks before body parsing, exact `Host` and `Origin`, body limits, tool-list change notification, removal of local credential selectors, transient upstream token injection, strict central requests, exact webhook shape, restart recovery, and scans of the isolated test home.

## Fixture status

This inventory records the original 2026-08-25 gate. The fixture was later updated on 2026-08-27 to match the live consuming REST poll and `{message_id,status:"acked"}` acknowledgement contract.

The Dockerized Python/FastMCP fixture has a hash-locked Python 3.13 image and eight in-container contract tests. The dedicated Ubuntu job builds its `test` target, then starts the runtime image read-only and non-root with no network, volume, or published port. The local Docker daemon is unavailable, so that build result comes from CI.

## Gate

Do not merge this red suite or begin production implementation until the user confirms that these failures represent the intended missing behavior and approves or changes ADRs `0018-mcp-sdk.md` and `0019-central-credential-storage.md`.
