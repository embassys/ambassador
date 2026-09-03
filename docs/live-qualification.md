# Live central qualification

## Purpose

This runbook records the controlled test of Ambassador's REST and DPoP client
against `https://mcp.embassys.ai`. It does not test central MCP, API-version
fallbacks, migration, token reissue, leases, conversations, or invented
general reply operations. It does test the deployed, action-specific
`submit_action_result` contract.

The runner covers the current package name, guided registration, one
full-message webhook target, and one direct target. The default direct target
is the deterministic mock ACP agent. Separately confirmed modes use the fixed
Codex, Claude Code, Hermes, or OpenClaw profiles. Real-provider modes use isolated provider
configuration copies. Installed-version probes are observational; production
requires the exact known client and ACP agent names and then tries the fixed
ACP v1 contract.

## Safety

- Use disposable Mailosaur addresses and synthetic action data.
- Read Mailosaur credentials from approved local secret storage.
- Keep addresses, codes, tokens, keys, proofs, messages, and payloads out of
  commands, files, logs, screenshots, and reports.
- Capture only route names, status, timing, digests, and safe pass/fail evidence.
- Delete captured mail and all temporary state in cleanup.

## Required live checks after the cutover

1. Pack and scan the exact candidate package.
2. Create two disposable identities through loopback local MCP.
3. Use the exact enabled `clientInfo.name` for one webhook profile and one
   direct profile. Prove a dual-mode profile advertises direct as its default;
   prove a direct-only profile proceeds without a delivery question.
4. Receive and use both verification emails without persisting their codes.
5. Restart and prove encrypted credential, encrypted webhook-secret, and
   nonsecret profile loading.
6. Prove valid Bearer plus DPoP requests and the negative DPoP matrix.
7. Validate the live action catalog against the recorded fixture schemas.
8. Request and decide one synthetic `get_phone_number` permission.
9. Deliver the action request to the direct target.
10. Submit one correlated synthetic result from the target and deliver the
    resulting `action_response` to the webhook requester.
11. Prove each local acceptance or completion precedes its central
    acknowledgement.
12. Record the consuming-poll restart-loss and non-idempotent result-submission
    limitations.
13. Stop all processes, delete mail and temporary state, and scan artifacts.

Use the mock webhook receiver and either the mock ACP agent or the fixed real
Codex mode for this live REST test. Real-agent qualification for all four
enabled profiles remains a separate local matrix in
[Delivery qualification](qualification.md).

The controlled runner must require an explicit confirmation phrase before any
live request. It must record the reviewed central source revision or note that
the deployment does not expose one.

After packing and clean-installing the candidate, set
`AMBASSADOR_PACKED_CLI`, `AMBASSADOR_PACKED_TARBALL`, and
`AMBASSADOR_CONFIRM_LIVE_QUALIFICATION` to the confirmation phrase embedded in
`scripts/live-qualification.mjs`, then run `pnpm run qualify:live`. In default
mode, the runner uses the mock ACP fixture compiled by `pnpm run test:build`
and does not run a paid provider.

For the real Codex mode, prepare an owner-only temporary home containing only
the copied Codex authentication needed for the run. Put the installed
`codex-acp` on `PATH`, then set:

```sh
export AMBASSADOR_LIVE_DIRECT_AGENT=codex
export AMBASSADOR_CODEX_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-codex-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

The runner rejects an ordinary user home, records the installed version when
one can be observed, uses the compiled-in Codex command and profile, and never
accepts a command override. The observation does not establish compatibility;
ACP v1 initialization with the exact known agent name remains authoritative.
The runner also lets
abandoned server-side polls expire after the restart check before it enqueues a
message. Delete the isolated home after the run.

For the real Claude Code mode, prepare an owner-only temporary home containing
an owner-only copy of `.claude.json` and a minimal
`.claude/settings.json`. The settings copy may pre-authorize only
`mcp__ambassador__respond_to_permission` and
`mcp__ambassador__submit_action_result` for this controlled synthetic run.
Provide the copy with the existing Claude authentication needed for the run
without printing it or saving it in the repository. Put the installed
`claude-agent-acp` on `PATH`, then set:

```sh
export AMBASSADOR_LIVE_DIRECT_AGENT=claude
export AMBASSADOR_CLAUDE_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-claude-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

The runner rejects the ordinary user home, non-owner-only configuration files,
and command overrides. It registers with exact MCP client name `claude-code`
and a deliberately non-release diagnostic version, launches only the
compiled-in `claude-agent-acp` command, requires ACP v1 and exact agent name
`@agentclientprotocol/claude-agent-acp`, and injects Ambassador MCP into the
ACP session. Delete the isolated home after every attempt.

For Hermes, prepare an owner-only temporary home containing only `.hermes/.env`,
`.hermes/auth.json`, `.hermes/config.yaml`, and
`.hermes/shared/nous_auth.json` copied from the authenticated installation.
Remove unrelated MCP entries only from that copy. Put the installed Hermes
Agent and `hermes-acp` on `PATH`, then choose one fixed mode:

```sh
export AMBASSADOR_HERMES_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_LIVE_DIRECT_AGENT=hermes-direct
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-hermes-direct-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

or:

```sh
export AMBASSADOR_HERMES_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_LIVE_DIRECT_AGENT=hermes-webhook
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-hermes-webhook-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

The runner rejects the ordinary Hermes home and non-owner-only copies. It uses
the exact MCP client name `mcp` with a deliberately non-release version value,
launches only compiled-in `hermes-acp` for direct mode, and configures
Ambassador MCP only in the isolated copy. The runner records the installed
Hermes version when it can, but does not use that observation as a compatibility
gate; direct mode requires ACP v1 and the exact `hermes-agent` name. Webhook
mode starts Hermes's authenticated generic route,
requires its bearer filter and native HMAC V2 validation, and suppresses
provider output. Delete the isolated home after every attempt.

For OpenClaw, prepare an owner-only temporary home containing copies of
`.openclaw/openclaw.json`, `.openclaw/state/openclaw.sqlite`, and
`.openclaw/agents/main/agent/openclaw-agent.sqlite`. Copy only the provider
credential used by that OpenClaw agent; for the tested Codex-backed agent this
also means `.codex/auth.json` and its provider configuration. Use SQLite's
backup operation for live database copies. Put the installed `openclaw` on
`PATH`, then choose one fixed mode:

```sh
export AMBASSADOR_OPENCLAW_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_LIVE_DIRECT_AGENT=openclaw-direct
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-openclaw-direct-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

or:

```sh
export AMBASSADOR_OPENCLAW_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_LIVE_DIRECT_AGENT=openclaw-webhook
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-openclaw-webhook-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

The runner rejects the ordinary OpenClaw home. It configures Ambassador MCP
only in the copy. Direct mode launches the fixed `openclaw acp` profile and
requires ACP v1 plus exact agent name `openclaw-acp`. Webhook mode creates the
secret through the packed Ambassador CLI, writes it to the copied
OpenClaw configuration through `openclaw config patch --stdin`, enables the
native `/hooks/agent` route for `main`, and runs the real OpenClaw gateway. It
does not install a plugin. Delete the isolated home after every attempt.

## Required report

Record only:

- date and reviewed server revision;
- live origin;
- packed Ambassador digest;
- qualification runner revision;
- status for each safe case;
- whether the target submitted a correlated action result and the requester
  received it;
- returned action names and schema digests;
- whether a DPoP nonce was observed;
- delivery mode used for each synthetic message;
- artifact-scan result; and
- the known consuming-poll and result-submission limitations.

Do not include identities, IDs, codes, tokens, JWK coordinates, proof claims,
messages, action payloads, permission scopes, webhook details, prompts,
provider output, or remote error bodies.

## Correlated-result observation

At 00:43 BST on 2026-09-03, the real Codex mode passed against the live service
with `codex-acp` 1.8.0 and packed candidate
`7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`.
The runner's UTC date field was still 2026-09-02. The reviewed central source
revision was `ac3f7a6e33829eb80301c7944f611d29cc2499b5`, the exact runner digest was
`769959d2bec4f7b436b9376570e940a14756c4f563e5f07343de9475c4cf3236`,
and the deployment did not expose its revision.

The run registered and verified two disposable Mailosaur identities. The mock
requester used webhook delivery; the target used direct ACP delivery to real
Codex. The requester asked for `get_phone_number`. Codex received the
`permission_request` through Ambassador's central poll and called
`respond_to_permission`. After central returned the grant to the requester's
webhook, the requester called `call_action`. Codex received the correlated
`action_call` and called `submit_action_result` exactly once with its `call_id`,
`success`, and the approved synthetic phone object. Central returned
`completed` and queued an `action_response` with the same call ID, action type,
status, and result. The requester received that response through its webhook,
and Ambassador acknowledged it.

The same run also passed encrypted restart, the DPoP positive case and missing,
wrong-key, stale, future, wrong-URL, wrong-method, wrong-token-hash, and replay
failures, the six-action live catalog and schema digests, acknowledgement order,
zero central MCP requests, artifact scanning, and mail and temporary-state
cleanup. The external isolated credential copy was removed after the run. No
defect appeared in the live `submit_action_result` path.

The pass used an owner-only `AGENTS.md` in the isolated Codex working directory
to represent the user's prior approval of only this synthetic permission and
result. It did not test a live interactive prompt to the user. An earlier run
without that local policy reached Codex, which called `respond_to_permission`,
but the permission was not granted; no action or result submission followed.
This is expected for a background ACP session with no interactive user.

A second attempt accepted the permission request but timed out before Codex
received it. The source and request sequence indicate that an abandoned
server-side long poll from the deliberate restart consumed the queued message
after its local HTTP request had been aborted. Central marks messages delivered
during polling and provides no lease or redelivery. The runner now waits 31
seconds after stopping the old gateways before it starts replacements; the
subsequent run passed. This is evidence of the existing restart-loss window,
not a failure of the result endpoint.

The live process used installed Node 24.14.0, below the package's declared
24.19.0 floor, because no in-range Node runtime was installed. Functional live
behavior passed. The supported-Node repeat remains part of the qualification
record even though the user approved 0.2.6 as a one-release exception before
that repeat.

## Claude Code observations

On 2026-09-03, real Claude Code passed the complete direct live-central flow on
macOS 26.5.2 arm64 and Node 24.19.0 using the actual published
`@embassys/ambassador@0.2.11` registry artifact. The clean-installed artifact
had npm integrity
`sha512-Tm8BxWFtsOso+Ns52bhxjI4VyEawUITlWF9qVcFlUK7mM+aaBmMYtUXiJwWum5TeUsLCM/zFRszP+dMAxTMO9A==`,
registry SHA-1 `184715279a4251f025c5fe438b08dedc7cd17816`, and tarball
SHA-256 `bca6d939b5c7faef975e3bb67b9c5f619d14cebe86a13b3b6f2341242be83d4c`.
Its installed CLI passed the current REST fixture before the live run. The live
runner SHA-256 was
`ba71e8e736e3c1ef2705062befb16294e79a24488e4163127b46d57e1ca0f96f`,
and the reviewed central source revision was
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`.

The fixed `claude-agent-acp` adapter was version 0.73.0 and used its official
Claude Agent SDK executable, observed as Claude Code 2.1.257. The separately
installed host Claude Code CLI was 2.1.259; the fixed adapter profile did not
substitute that executable. Version values were recorded only as diagnostics.
ACP v1 initialization with exact agent name
`@agentclientprotocol/claude-agent-acp`, real model execution, and injected
Ambassador MCP calls provided the compatibility evidence.

The run registered and email-verified two disposable Mailosaur identities
through separate local Ambassador MCP endpoints. The direct-only Claude target
registered with exact MCP client name `claude-code` and a deliberately
non-release version value, then reloaded its encrypted central credential and
delivery profile after Ambassador restarted. Live REST and DPoP behavior and
the deployed six-action catalog passed. The real model received the
`permission_request`, called `respond_to_permission` with a grant, received the
complete correlated `action_call`, and called `submit_action_result` exactly
once with the supplied call ID, success status, and approved synthetic phone
result. The requester received the matching `action_response`. Local direct
completion preceded each central acknowledgement.

The artifact scan and cleanup checks passed. Captured mail and temporary
Ambassador state were deleted. The external owner-only Claude configuration
copy was removed after the run, and the normal Claude home was not changed. No
credential, identity, code, prompt, message body, or provider output was
recorded.

## Hermes 0.20.5 observations

On 2026-09-03, Hermes Agent 0.20.5 ran on macOS 26.5.2 arm64 with Node
24.19.0. Both live cases reviewed central source revision
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`; the live deployment did not
expose its revision. The actual npm artifact was downloaded from the registry,
clean-installed, and used through its installed `ambassador` CLI. Its npm
integrity was
`sha512-qaL4IHTrMwpyrY1OisPXMexytmnNfO7Bjc5tXgLCF3LolXQW2R8GrzErqJkMIlM+Zh8Cce9ijN+zfYb3xiNHSQ==`,
its registry SHA-1 was `c0179df957bc05de921da578344fab6c1ba4a713`,
and its tarball SHA-256 was
`312b514ce2dd43de81502debd63004ea9a84da79099d4730c301b52e593c97c8`.
The installed CLI started without options, rejected a forbidden option, and
passed the packed-runtime scan.

The artifact-specific outcomes were:

| Delivery case | Ambassador artifact | Outcome |
| --- | --- | --- |
| Webhook | Published `@embassys/ambassador@0.2.7` | Passed the complete live round trip |
| Direct eligibility probe | Published `@embassys/ambassador@0.2.7` | Ambassador capability-registry rejection at `startup_failed`, as required by its exact 0.21.0 profile |
| Direct | Source candidate adding exact Hermes ACP 0.20.5 | Passed the complete live round trip |

The source-built direct candidate was not substituted for the published
artifact checks. Its tarball SHA-256 was
`1d434e8a5dbf027a42326a7e6b42a58094fe17cfdbf8cf96a4e7d314a24835be`,
and the direct qualification runner SHA-256 was
`7b6a680bba64abe8d86c9f2328a7562360b15def1eea1d7cf11f21d8f7dea24f`.
The final strict webhook pass used runner SHA-256
`e2506c09012f5e7bb3630acb70b5844be3a1769b5baaef3fc76dda07ed27c8c0`.
No later source change altered the direct profile or delivery implementation
used by that candidate.

Each pass registered and email-verified a controlled requester and the real
Hermes target through separate local Ambassador MCP endpoints, then restarted
both gateways and reloaded the encrypted credentials and delivery profiles.
The requester obtained `get_phone_number` permission, Hermes called
`respond_to_permission` with a grant, the requester called `call_action` with
approved synthetic data, and Hermes received the complete correlated
`action_call`. The real model called `submit_action_result` exactly once with
the supplied call ID, success status, and approved synthetic phone object.
The requester received the matching `action_response`. Local webhook custody
or ACP completion was observed before each corresponding central
acknowledgement.

Both modes passed Bearer plus DPoP behavior, the negative DPoP matrix, the
deployed six-action catalog, zero central MCP requests, artifact scanning, and
Mailosaur and temporary-state cleanup. Direct mode proved ACP v1 initialization
and injected Ambassador MCP. Webhook mode proved the Hermes receiver's bearer
filter, HMAC V2 authentication, and custody before acknowledgement. The normal
Hermes home was not changed; owner-only credential copies were removed after
the runs.

The live DPoP positive case needed no nonce. The deployed catalog names and
input-schema SHA-256 digests were:

| Action | Input schema SHA-256 |
| --- | --- |
| `create_calendar_event` | `4b9c97f146bfbb4c2cc1ec0812ada60406ce563d59c5abc807fcb6ba2dc0270c` |
| `get_email` | `032af9a4835a30e280f7c122f8971565b4e2527b25d9fcb0ad2f778f654aecbd` |
| `get_free_busy_permission` | `7775afae503f343ae09ed3510c66410cb361ea4125b28047d15321e7430f4f96` |
| `get_phone_number` | `6c7954b7f42f818db7f93433bd07dc2aac273bd4599a637d2233529c6149bc48` |
| `read_calendar_event_by_title` | `92ddb62ec62f187cdd1cfe0995d01afd06f283f2c174f6f24173083b1aab0d2f` |
| `read_calendar_permission` | `27deb9a2fbadef8582fa9036fa9bc4a173eeaa92034d0fab8f4e12b1dfdf0662` |

One earlier strict webhook attempt failed at
`action_response_webhook_timeout_failed` after the real target had granted the
permission, submitted one successful correlated result, accepted both target
messages, and received both target acknowledgements. Ambassador reported no
stderr. The safe evidence cannot distinguish central response queueing from a
consuming-poll delivery loss, so this is classified in the central REST
action-response delivery phase, not as Ambassador target delivery, Hermes
webhook custody, model execution, or MCP invocation. A fresh isolated rerun of
the same strict case passed. No compatibility fallback or replay was added.

These observations approve the source registry's exact Hermes ACP 0.20.5
entry. They do not show that published Ambassador 0.2.7 supports Hermes 0.20.5
direct mode. Ambassador 0.2.8 contains the candidate change.

## OpenClaw observations

On 2026-09-03, authenticated OpenClaw 2026.8.2 ran on macOS arm64 with Node
24.19.0 and passed the complete live correlated-result flow in direct and
webhook modes with the Ambassador 0.2.10 candidate. Both modes registered and
verified two disposable identities, reloaded encrypted Ambassador state after
restart, exercised live REST and DPoP plus the deployed action catalog, and
completed the synthetic phone-number permission and action round trip. The
real OpenClaw model called `respond_to_permission` and called
`submit_action_result` exactly once. The controlled requester received the
correlated final response, and local completion or webhook custody preceded
central acknowledgement. Final candidate digests and the separate mode results
are recorded in [Delivery qualification](qualification.md).

Direct mode proved ACP v1 initialization through fixed `openclaw acp`, exact
agent name `openclaw-acp`, provider-side Ambassador MCP configuration, real
model execution, and correlated submission. An earlier isolation attempt
omitted the credential for the agent's configured provider backend; OpenClaw
then ended the model turn with an authentication failure before any Ambassador
MCP call. Adding that owner-only credential to the isolated copy made the
unchanged direct flow pass. This was an isolation-fixture failure, not an
Ambassador ACP incompatibility.

Webhook mode proved the package-shipped route's bearer and exact-body HMAC V2
checks, bounded custody queue, real model execution, Ambassador MCP calls, and
the final response. Earlier receiver attempts returned `202` and Ambassador
correctly acknowledged central, but OpenClaw made no model or MCP call. The
first implementation omitted required embedded-run fields. After those were
added, the detached run inherited the HTTP handler's released work-admission
lease and OpenClaw rejected it with the safe class `GatewayDrainingError`. A
plugin-service queue created outside the request context removes that false
drain path. A `202` still proves custody only; the passing run waited for the
model calls and requester response.

All OpenClaw attempts used an owner-only isolated home. Mailosaur messages,
temporary Ambassador state, the OpenClaw copy, and copied provider credentials
were removed after qualification. No provider output or message content was
recorded.

## Earlier direct observation

On 2026-09-02, real Codex had already passed delivery, injected Ambassador MCP
use, and acknowledgement with candidate
`22a65d370897172a726b4890bade780e907c2c38ccf5d6cb5e347c9c01f14ec7`.
That run predated adoption of `submit_action_result` and is not evidence for the
correlated-result contract. Earlier mock-target delivery timeouts remained
unexplained at that point; the restart race above now explains one reproducible
class of such timeout.

## Baseline observation

On 2026-09-02, the packed pre-ADR-0038 implementation passed registration, Mailosaur
email receipt, verification, encrypted restart, the DPoP positive and negative
matrix, six-action catalog validation, permission request and decision,
permission-response delivery, one `get_email` delivery, consuming polls,
acknowledgements, and forbidden-marker scans.

It used no central MCP request and observed no initial nonce challenge. The
final `get_my_permissions` check matched the deployed email-field model.
Captured mail and temporary process state were deleted.

This observation remains useful evidence for ADR 0037 only. It is not release
evidence for the Ambassador delivery cutover.
