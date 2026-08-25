# Red test failure inventory

Status: awaiting user review

Date: 2026-08-25

## Local Node run

`npm test` compiles the production and test TypeScript, then runs 146 tests.

| Result | Count |
| --- | --- |
| Pass | 144 |
| Fail | 2 |

The 142 legacy tests still pass. The dependency-free central contract test and strict split-option rejection also pass.

## Expected failures

### Removed commands still exist

`test/single-webhook-cli.test.ts` expects the legacy `setup` command to exit with code 2. The current implementation exits 0 and writes the old JSON configuration. This is missing replacement behavior, not a fixture defect.

### New foreground start does not exist

`test/single-webhook-e2e.test.ts` invokes:

```text
a2a-gateway start --webhook-url=<loopback-url> --webhook-token-env=A2A_WEBHOOK_TOKEN
```

The current CLI exits 2 with `Invalid command or arguments` before binding MCP. This is the first missing behavior in the end-to-end path. Later assertions in the same test define local MCP authentication, enrollment, JWT stripping and injection, ID-only polling, separate acknowledgements, webhook wake, content retrieval, and plaintext scans.

## Fixture status

The Node central fake passes its acknowledgement contract independently: notification acknowledgement stops ID redelivery without hiding content from MCP, and content remains available until idempotent `ack_message` succeeds.

The Dockerized Python/FastMCP fixture is tested in the dedicated Ubuntu CI job because this machine has no running Docker daemon and its system Python is 3.9. The approved fixture requires Python 3.13.

## Gate

Do not merge this red suite or begin production implementation until the user confirms that these failures represent the intended missing behavior and approves or changes ADRs `0018-mcp-sdk.md` and `0019-central-credential-storage.md`.
