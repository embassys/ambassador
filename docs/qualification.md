# Delivery qualification

This strategy separates deterministic product behavior from third-party agent
behavior.

## CI delivery suite

CI uses the independent local central fixture plus two test targets. It does
not require a model account, network access, email delivery, or production
central.

### Mock webhook receiver

The receiver records bounded metadata and validates:

- the complete canonical central message body;
- bearer and HMAC V2 authentication;
- timestamp and signature coverage of the exact bytes;
- matching request and idempotency IDs;
- retries before acceptance and no local redelivery after acceptance;
- central acknowledgement only after a 2xx response; and
- shutdown, timeout, duplicate, malformed-response, and capacity behavior.

Test failures may report a case name and safe status. They must not print the
message, payload, secret, signature material, or request headers.

### Mock ACP v1 agent

The mock is a small NDJSON ACP v1 peer controlled by the test. It validates:

- initialize and capability negotiation;
- new-session and supported resume behavior;
- Ambassador MCP session configuration;
- one complete-message prompt with fixed untrusted-input instructions;
- normal terminal completion and acknowledgement order;
- pre-dispatch startup failure;
- permission request denial or bounded handling;
- malformed output, overflow, timeout, cancellation, child exit, and cleanup;
  and
- no automatic replay after an uncertain prompt dispatch.

The mock must run without a shell and expose deterministic barriers so tests can
place crashes before and after every external-effect boundary.

### Shared cases

Both modes run the same queue, body-size, batch, deadline, concurrency,
singleton, graceful-shutdown, restart-loss, and forbidden-marker scans. SQLite
and the delivery profile must remain free of message content and secret values.

Registration cases also prove:

- exact allowlisted `clientInfo` aliases select only their fixed profile;
- unknown, ambiguous, disabled, and incomplete profiles return
  `unsupported_agent` before state or a central call;
- supplying a delivery object cannot bypass profile resolution;
- a complete direct-only test profile proceeds without a question;
- OpenClaw and Hermes ask direct versus webhook with direct as the default;
- agent kind and process configuration are rejected as tool input; and
- a failed direct launch never falls back to webhook.

These tests are mandatory on Linux and macOS for every pull request that
changes delivery.

## Local real-agent suite

Real-agent qualification is opt-in and runs locally because it needs installed,
authenticated agent software and may incur model cost. It uses the local
central fixture by default, so provider integration can be tested without a
production identity or verification email.

The first required matrix is:

| Agent | Webhook mode | Direct mode |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |

For each row:

1. Create an isolated provider profile and bounded working directory.
2. Start the packed Ambassador candidate with a fresh local token.
3. Configure Ambassador MCP through the provider's supported mechanism.
4. Register a synthetic fixture identity and prove the real MCP client's exact
   alias selects the expected fixed profile. Choose the requested mode when the
   dual-mode result asks, and prove direct is its advertised default.
5. Inject one permission message and one action message through the fixture.
6. Prove the real agent receives the complete message.
7. Prove the agent can call an allowed Ambassador MCP tool.
8. Prove local completion or webhook acceptance precedes fixture
   acknowledgement.
9. Exercise one bounded failure and confirm no unsafe replay.
10. Stop all processes and scan the isolated state and output.

OpenClaw webhook qualification installs a receiver-side mapping from the
canonical Embassys JSON message to OpenClaw's native hook input. Direct
qualification uses OpenClaw's ACP command and its preconfigured Ambassador MCP
entry when session MCP injection is unavailable.

Hermes webhook qualification uses its authenticated generic webhook path.
Direct qualification uses its ACP command and session MCP configuration when
supported by the tested version.

The runner must require explicit confirmation, use already installed
executables, and never install or update an agent. It records:

- operating system and architecture;
- packed Ambassador digest;
- provider and ACP adapter versions;
- fixture revision;
- case names and pass/fail status; and
- whether session MCP injection or provider configuration was used.

It does not record prompts, replies, message bodies, payloads, identities,
tokens, secrets, provider credentials, paths containing user data, or raw
provider output.

Build and pack the exact candidate, start the independent central fixture on
the default `http://127.0.0.1:8000`, and configure the two already-authenticated
webhook receivers. Then run:

```sh
export AMBASSADOR_CANDIDATE_TARBALL=/absolute/path/to/ambassador.tgz
export AMBASSADOR_QUALIFY_CONFIRM=run-installed-openclaw-and-hermes
export AMBASSADOR_QUALIFICATION_LOCAL_TOKEN='<48-lowercase-hex-token>'
export AMBASSADOR_OPENCLAW_WEBHOOK_URL=https://receiver.example/openclaw
export AMBASSADOR_OPENCLAW_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_HERMES_WEBHOOK_URL=https://receiver.example/hermes
export AMBASSADOR_HERMES_WEBHOOK_SECRET='<secret>'
pnpm run build
pnpm run qualify:agents
```

Put secret values in the process environment, never in command arguments. The
runner first requires the local fixture readiness endpoint, verifies the
installed provider versions, loads the code from the exact candidate archive,
runs all four delivery cases, and prints one safe JSON report. Configure the
OpenClaw provider-side MCP entry for `http://127.0.0.1:8787/mcp` with the local
token above before starting the runner; Hermes receives the same endpoint by
ACP session injection. Each direct case must call the qualification
`get_my_permissions` tool, which proves the real MCP client's exact
`clientInfo` match. Missing, mismatched, unauthenticated, or failing agents
make the run fail; the runner never invokes an installer or updater.

The production ACP dependency is exact `@agentclientprotocol/sdk` 1.4.0. It is
Apache-2.0 licensed, as approved by ADR 0038, and remains subject to the normal
lockfile, audit, provenance, and packed-artifact checks.

Codex and Claude can join this matrix after their exact ACP adapter contracts
are approved, implemented, and qualified. Until then, their `clientInfo`
values are unsupported rather than partially recognized.

## Live central suite

Live central qualification remains separate. It proves email registration,
DPoP, current REST schemas, permissions, message consumption, and
acknowledgement against [mcp.embassys.ai](https://mcp.embassys.ai).

After the delivery cutover, its deterministic local target should exercise one
webhook delivery and one mock-ACP direct delivery. Running a paid real agent
against live central is optional and does not replace either the fixture-based
real-agent matrix or the deterministic live REST checks.

See [Live central qualification](live-qualification.md) for the existing
baseline evidence and safety rules.
