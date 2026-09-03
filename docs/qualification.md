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
- target-side `submit_action_result` and correlated `action_response` delivery;
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
- all five enabled profiles ask direct versus webhook with direct as the
  default;
- agent kind and process configuration are rejected as tool input; and
- a failed direct launch never falls back to webhook.

These tests are mandatory on Linux and macOS for every pull request that
changes delivery.

## Local real-agent suite

Real-agent qualification is opt-in and runs locally because it needs installed,
authenticated agent software and may incur model cost. It uses the local
central fixture by default, so provider integration can be tested without a
production identity or verification email.

The required matrix is:

| Agent | Webhook mode | Direct mode |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |
| Codex | required | required |
| Claude Code | required | required |
| Gemini CLI | required | required |

For each row:

1. Create an isolated provider profile and bounded working directory.
2. Start the packed Ambassador candidate with a fresh local token.
3. Configure Ambassador MCP through the provider's supported mechanism.
4. Register a synthetic fixture identity and prove the real MCP client's exact
   alias selects the expected fixed profile. Choose the requested mode when the
   dual-mode result asks, and prove direct is its advertised default.
5. Inject one permission message and one action message through the fixture.
6. Prove the real agent receives the complete message.
7. Prove the agent can call an allowed Ambassador MCP tool. For an action call,
   require one correlated `submit_action_result` call.
8. Prove the requester receives the resulting `action_response` before both
   delivered messages are acknowledged.
9. Exercise one bounded failure and confirm no unsafe replay.
10. Stop all processes and scan the isolated state and output.

OpenClaw webhook qualification installs a receiver-side mapping from the
canonical Embassys JSON message to OpenClaw's native hook input. Direct
qualification uses OpenClaw's ACP command and its preconfigured Ambassador MCP
entry when session MCP injection is unavailable.

Hermes webhook qualification uses its authenticated generic webhook path.
Direct qualification uses its ACP command and session MCP configuration when
supported by the tested version.

Codex direct qualification uses `@agentclientprotocol/codex-acp` 1.8.0 and
proves that the adapter injects Ambassador MCP into its Codex App Server
session. Claude Code direct qualification uses
`@agentclientprotocol/claude-agent-acp` 0.73.0 and its exact Claude Agent SDK
0.3.257 dependency. Gemini CLI direct qualification uses native
`gemini --acp` at 0.58.0. All three receive Ambassador MCP through ACP session
configuration.

On 2026-09-02, isolated installs of the three approved entry points passed ACP
v1 initialization and returned the exact `agentInfo` identities in ADR 0038.
The reviewed OpenClaw and Hermes images also passed their version and ACP
startup probes. These are safe contract probes, not real-agent delivery passes.
The Codex direct case first passed against the local fixture. On 2026-09-03 it
passed the live correlated-result flow with packed candidate
`7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`
and reviewed central revision
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`. Two disposable identities
registered and verified through Mailosaur. The controlled requester obtained a
synthetic phone permission, central polled the request and action to real Codex,
Codex called `respond_to_permission` and `submit_action_result` through the
injected Ambassador MCP server, and the requester received the correlated
`action_response` through its webhook before acknowledgement. The pass used a
narrow isolated policy representing the user's prior approval; it did not test
an interactive user prompt. Captured mail and temporary state were deleted.
The isolated credential copy was also removed. The installed Node was 24.14.0,
below the supported 24.19.0 floor, so repeat this case on a supported runtime.
The other nine cases remain open. The user approved 0.2.6 as a one-release
exception before this evidence was complete; these cases remain required to
complete the qualification record.

The runner must require explicit confirmation and use exact executables already
available on `PATH`. Those executables may come from an isolated installation
or a reviewed container wrapper prepared before the run. The runner never
installs, updates, or pulls an agent. It records:

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
the default `http://127.0.0.1:8000`, and configure the five authenticated
webhook receivers. Then run:

```sh
export AMBASSADOR_CANDIDATE_TARBALL=/absolute/path/to/ambassador.tgz
export AMBASSADOR_QUALIFY_CONFIRM=run-installed-supported-agents
export AMBASSADOR_QUALIFICATION_LOCAL_TOKEN='<48-lowercase-hex-token>'
export AMBASSADOR_OPENCLAW_WEBHOOK_URL=https://receiver.example/openclaw
export AMBASSADOR_OPENCLAW_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_HERMES_WEBHOOK_URL=https://receiver.example/hermes
export AMBASSADOR_HERMES_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_CODEX_WEBHOOK_URL=https://receiver.example/codex
export AMBASSADOR_CODEX_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_CLAUDE_WEBHOOK_URL=https://receiver.example/claude
export AMBASSADOR_CLAUDE_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_GEMINI_WEBHOOK_URL=https://receiver.example/gemini
export AMBASSADOR_GEMINI_WEBHOOK_SECRET='<secret>'
pnpm run build
pnpm run qualify:agents
```

Put secret values in the process environment, never in command arguments. The
runner first requires the local fixture readiness endpoint, verifies the
installed provider versions, loads the code from the exact candidate archive,
runs all ten delivery cases, and prints one safe JSON report. Configure the
OpenClaw provider-side MCP entry for `http://127.0.0.1:8787/mcp` with the local
token above before starting the runner. The other four profiles receive the
same endpoint by ACP session injection. Each direct case must call the
qualification `get_my_permissions` tool, which proves the real MCP client's
exact `clientInfo` match. Missing, mismatched, unauthenticated, or failing
agents make the run fail; the runner never invokes an installer or updater.

The reviewed OpenClaw 2026.8.1 and Hermes 0.21.0 images may provide their exact
executables. Pin `ghcr.io/openclaw/openclaw:2026.8.1` to manifest digest
`sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4`
and `nousresearch/hermes-agent:v2026.8.31` to manifest digest
`sha256:64923faeae267792bf9bf87fe3b4c4869e35004e360c7df01730ad801b74d524`.
Use isolated writable copies of provider configuration. Do not mount a user's
live configuration directory into a qualification container. Container
networking must preserve access to Ambassador's authenticated loopback MCP
listener; an image version or ACP handshake alone is not a real-agent pass.

The production ACP dependency is exact `@agentclientprotocol/sdk` 1.4.0. It is
Apache-2.0 licensed, as approved by ADR 0038, and remains subject to the normal
lockfile, audit, provenance, and packed-artifact checks.

## Live central suite

Live central qualification remains separate. It proves email registration,
DPoP, current REST schemas, permissions, correlated action results, message
consumption, and acknowledgement against
[mcp.embassys.ai](https://mcp.embassys.ai).

After the delivery cutover, its deterministic local target should exercise one
webhook delivery and one mock-ACP direct delivery. Running a paid real agent
against live central is optional and does not replace either the fixture-based
real-agent matrix or the deterministic live REST checks.

See [Live central qualification](live-qualification.md) for the existing
baseline evidence and safety rules.
