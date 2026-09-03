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

- exact known `clientInfo.name` values select only their fixed profile while
  reported client versions do not gate registration;
- unknown, ambiguous, disabled, and incomplete profiles return
  `unsupported_agent` before state or a central call;
- supplying a delivery object cannot bypass profile resolution;
- Codex, Claude Code, Gemini CLI, and a complete direct-only test profile
  proceed without a question;
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

The required matrix is:

| Agent | Webhook mode | Direct mode |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |
| Codex | not supported | required |
| Claude Code | not supported | required |
| Gemini CLI | not supported | required |

For each row:

1. Create an isolated provider profile and bounded working directory.
2. Start the packed Ambassador candidate with no CLI options.
3. Configure Ambassador MCP through the provider's supported mechanism.
4. Register a synthetic fixture identity and prove the real MCP client's exact
   name selects the expected fixed profile regardless of its reported version.
   Choose the requested mode when the dual-mode result asks, and prove direct
   is its advertised default.
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
Direct qualification uses its fixed ACP command and session MCP configuration.

Codex and Claude Code direct qualification use their installed ACP adapters;
Gemini CLI direct qualification uses native `gemini --acp`. All three receive
Ambassador MCP through ACP session configuration. The runner records installed
versions as evidence but does not use them as allowlists.

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

On 2026-09-03, locally authenticated Hermes Agent 0.20.5 passed the same live
correlated-result flow in both delivery modes on macOS 26.5.2 arm64 and Node
24.19.0. The webhook case used the actual published Ambassador 0.2.7 tarball.
The direct case used a source candidate containing the new exact `0.20.5` ACP
entry. Hermes called `respond_to_permission` and called
`submit_action_result` exactly once; the requester received the correlated
response, and local acceptance or completion preceded central acknowledgement.
Both cases used isolated owner-only provider configuration and removed mail,
temporary Ambassador state, and copied provider credentials. See
[Live central qualification](live-qualification.md) for package digests,
separate mode outcomes, and the safe failure record.

Published Ambassador 0.2.7 still accepts only Hermes ACP 0.21.0 for direct
delivery. Its installed CLI rejected Hermes ACP 0.20.5 with `startup_failed`,
as expected. The candidate pass qualifies adding exact 0.20.5 to source; it is
not evidence that the already published 0.2.7 artifact has that support.

Four profile/mode cases remain open: OpenClaw webhook and direct, Claude Code
direct, and Gemini CLI direct. The user approved 0.2.6 as a one-release
exception before this evidence was complete; the remaining cases are still
required to complete the qualification record. Hermes 0.21.0 retains only its
earlier contract and ACP startup probe and has not run the full real-model
round trip.

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

The installed-command version probe is observational. Run it without provider
credentials or model work:

```sh
pnpm run probe:agents
```

It checks OpenClaw, Hermes, Codex ACP, Claude Agent ACP, and Gemini through
fixed version commands. A bounded semantic version is `observed`; a missing,
failing, malformed, or timed-out command is `unavailable`. Neither result
skips a delivery case. The production direct target separately requires ACP
v1 and the exact compiled-in ACP agent name after initialization; its reported
version remains observational.

On 2026-09-03, the observational probe was rerun for the 0.2.9 candidate on
macOS 26.5.2 arm64 with Node 24.19.0:

| Profile | Probe status | Reported version |
| --- | --- | --- |
| OpenClaw | `unavailable` | none |
| Hermes | `observed` | `0.20.5` |
| Codex ACP | `unavailable` | none |
| Claude Agent ACP | `unavailable` | none |
| Gemini CLI | `unavailable` | none |

`unavailable` means the executable was not available to this probe. It is not
a compatibility verdict. The candidate's deterministic registration and ACP
tests also passed with deliberately non-release version strings for every
known MCP client and with a mismatched ACP agent version under the correct ACP
v1 protocol and agent name.

The byte-final 0.2.9 candidate tarball had SHA-256
`49983cb0cf5b18ebaab9bbeab734dad837788c05f712c498a1e3cafc4ece015d`
and SRI digest
`sha512-faspZV5pqwtvwHJ8NxnW+KAoT2vLSu2oeYIc9RknjDl8m9oAYvqcTxVkcyj1yutqGpxWJKPHlg5xyXLpuwyYdw==`.
On Node 24.19.0 it passed clean installation, the installed-package REST E2E,
and the production vulnerability audit with no known vulnerabilities. The
signature audit verified 20 registry dependencies and reported only the
expected missing registry metadata for the unpublished local 0.2.9 candidate.
The full repository check passed 157 tests with no failures; the two opt-in
package lanes were skipped in that command, and the clean-installed package
lane then passed separately. Version 0.2.9 was not present in the npm registry
at verification time.

After all five pull-request gates passed, PR 15 merged as
`1d4a93c1c02f9abc7ca8c55761907c1a62be703f`. The main-branch Linux, macOS,
package, and Docker central-fixture jobs passed, and its OIDC job published
0.2.9 with the npm `latest` tag. The tarball downloaded directly from npm's
published `dist.tarball` URL matched registry SRI
`sha512-SgOUG35EtxTL02y9rWxvaDHnvmGgajY0a86w6ff2Jz+PEjpKXTHd2K+B0cuwb+yFjakl4PZDF039oQmsy4jOFw==`
and registry SHA-1 `293f1cc8b95b8306445aab02deb3286b0fc387ac`; its SHA-256 was
`e35e705f42411a29cf6afe185fc018de536230b717aebf25c15016a26118e5f6`.
A clean install of that registry tarball passed the installed CLI REST E2E, the
installed `ambassador` command rejected a forbidden option, the production
audit found no known vulnerabilities, and the signature audit verified all 21
packages with no invalid or missing entries. A separate check imported code
from that clean registry install: all five known MCP client names resolved with
a deliberately non-release version value, and direct ACP delivery completed
when the mock agent returned the correct ACP v1 protocol and agent name with a
different version.

The byte-final 0.2.8 release candidate tarball had SHA-256
`6e128f2ec84af29ad663226e1449de9c1fb894426b3982982cab0215667a24f4`
and SRI digest
`sha512-EWoq/E6GUHguCIhVi2qKWk0RUODPAsVHeAywbxEE8iDzKkXrj9r6EjarfheOujKP4V4Cxb3rCKzegc3HgjxxvQ==`.
On Node 24.19.0 it passed clean installation, the installed-package REST E2E,
and the production vulnerability audit with no known vulnerabilities. The
signature audit verified 20 registry dependencies and reported only the
expected missing registry metadata for the unpublished local 0.2.8 candidate.
The full repository check passed 158 tests with no failures; two separate
opt-in fixture lanes were skipped locally and remain required in CI.

After the green pull-request gates and main-branch OIDC workflow, npm published
0.2.8 and assigned `latest` to it. The downloaded registry artifact had npm SRI
`sha512-iGUTyiZW1X3ufniNgD8HvTniD56zVOHIgPuyLlaelAblU5nhYEV9aCgKpEUOCTvh+VaY72BfxAinssgQpHtUYQ==`,
registry SHA-1 `9188429b5933d7776cdf356578aad297bd3fc64b`, and tarball
SHA-256 `d6caf9a6c7285642bbd7ccdcb40fc89109dfd97deb157513071c8c50d6604e7c`.
Its extracted files were identical to the candidate despite the archive-level
digest difference. A clean registry-artifact install passed the REST E2E through
the installed CLI entry, the installed `ambassador` command rejected a forbidden
option, the production audit found no known vulnerabilities, and the registry
signature audit verified all 21 packages with no invalid or missing entries.

The runners do not record prompts, replies, message bodies, payloads, identities,
tokens, secrets, provider credentials, paths containing user data, or raw
provider output.

Build and pack the exact candidate, start the independent central fixture on
the default `http://127.0.0.1:8000`, and configure the two authenticated
webhook receivers. Then run:

```sh
export AMBASSADOR_CANDIDATE_TARBALL=/absolute/path/to/ambassador.tgz
export AMBASSADOR_QUALIFY_CONFIRM=run-installed-supported-agents
export AMBASSADOR_OPENCLAW_WEBHOOK_URL=https://receiver.example/openclaw
export AMBASSADOR_OPENCLAW_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_HERMES_WEBHOOK_URL=https://receiver.example/hermes
export AMBASSADOR_HERMES_WEBHOOK_SECRET='<secret>'
pnpm run build
pnpm run qualify:agents
```

Put secret values in the process environment, never in command arguments. The
runner first requires the local fixture readiness endpoint, observes the
installed provider versions, loads the code from the exact candidate archive,
runs all seven delivery cases, and prints one safe JSON report. Configure the
OpenClaw provider-side MCP entry for `http://127.0.0.1:8787/mcp` without
authentication before starting the runner. The other four profiles receive the
same endpoint by ACP session injection. Each direct case must call the
qualification `get_my_permissions` tool, which proves the real MCP client's
exact name match. Missing, unauthenticated, or failing agents make the delivery
case fail; a version-command observation does not. The runner never invokes an
installer or updater.

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
