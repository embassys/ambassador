# Current work

The Ambassador delivery cutover and zero-configuration startup are implemented.
The deterministic suite covers guided registration, complete-message webhook
delivery, direct ACP v1 delivery, correlated action-result submission,
automatic central acknowledgement, restart loss, bounded state, internal
credential-key custody, checked local cleanup, and packed-package installation.
Completed design and behavior live in the architecture, protocol, and ADRs
rather than this plan.

Published Ambassador 0.2.9 corrected the version policy under ADR 0041.
Published Ambassador 0.2.11 removes the 0.2.10 OpenClaw receiver and sends
OpenClaw's fixed webhook profile directly to its native `/hooks/agent`
endpoint. It keeps Hermes on the canonical bearer and HMAC V2 contract. The
byte-final candidate passed the Node 24.19.0 repository and clean-package
checks plus complete live-central webhook round trips with OpenClaw 2026.8.2
and the authenticated Hermes setup. PR 23, the main-branch release gates, npm
OIDC publication, and independent registry-artifact verification all passed.
Exact known MCP client names still select fixed profiles, and exact ACP v1
agent names still protect direct initialization, but reported client and agent
versions do not gate either step. Ambassador tries the fixed contract and
surfaces an actual startup, initialization, session, or delivery failure. The
0.2.10 passed its local checks, four-case Hermes/OpenClaw live-central matrix,
pull-request gates, and main-branch release gates. The downloaded npm artifact
was independently verified. Its digests and results are recorded in
[Delivery qualification](qualification.md).

Published Ambassador 0.2.12 adds the checked local-only `ambassador clean`
reset under ADR 0044. Its Node 24.19.0 repository, packed-package,
live-central, pull-request, and main-branch gates passed. The npm OIDC job
published the package with the `latest` tag, and the independently downloaded
registry artifact passed integrity, file-tree, installed-CLI cleanup,
vulnerability, and signature checks. Published 0.2.11 and earlier artifacts do
not gain the command retroactively. The recorded digests and results are in
[Delivery qualification](qualification.md).

## Remaining qualification

The user explicitly approved `@embassys/ambassador@0.2.6` and the corrective
0.2.7 release on 2026-09-03 before completion of the then-current real-agent
matrix. That historical exception is not evidence that its open cases passed.
Gemini CLI has since been removed from the active registry and Antigravity is
deferred under ADR 0043. The current four-profile matrix has live evidence for
every supported mode. The remaining supported-runtime repeat and historical
artifact checks are recorded below.

- Claude Code direct passed the complete live correlated-result flow on
  2026-09-03 with published Ambassador 0.2.11, Claude Agent ACP 0.73.0, and its
  bundled Claude Code 2.1.257 executable. The host's separate Claude Code
  2.1.259 installation was observed but was not substituted for the fixed ACP
  adapter executable. The real model called `respond_to_permission` and
  `submit_action_result` exactly once, and the controlled requester received
  the correlated response. The run used Node 24.19.0 and an isolated
  owner-only provider configuration, which was removed afterward.
- Codex direct passed the
  complete live correlated-result flow on 2026-09-03 against packed candidate
  `7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`
  and reviewed central revision
  `ac3f7a6e33829eb80301c7944f611d29cc2499b5`: the authenticated target called
  `respond_to_permission` and `submit_action_result`, and the controlled
  requester received the correlated `action_response`. The run used an
  isolated preapproval policy, not an interactive user prompt. Repeat it on a
  supported Node release; the installed 24.14.0 runtime was below the 24.19.0
  floor. Its isolated credential copy was removed after the run.
- Hermes Agent 0.20.5 and OpenClaw 2026.8.2 passed both direct and webhook live
  central delivery with the byte-final 0.2.10 candidate. These version values
  are observations, not allowlist entries. Both agents registered with exact
  MCP client information `mcp` / `0.1.0`; direct delivery retained exact ACP
  v1 agent-name checks. The isolated copies of their existing credentials were
  removed after the runs.
- The isolated ACP initialization probes pass for Codex ACP 1.8.0, Claude
  Agent ACP 0.73.0, OpenClaw, and Hermes. Claude Agent ACP has also passed the
  complete authenticated live flow.
  These probes do not replace an authenticated prompt and observed Ambassador
  MCP call.
- Record only the safe version and pass/fail evidence produced by
  `scripts/qualify-agents.mjs`. Do not record prompts, messages, credentials,
  secrets, paths containing user data, or provider output.
- Keep provider versions in dated qualification evidence only. Getting-started
  guides should direct users to current releases and explain that actual ACP
  compatibility is tried rather than inferred from the reported version.

## Windows qualification

ADR 0040 reopens Windows work. The candidate CI and package lanes now pass and
cover native state DACLs, SQLite and lock behavior, webhook delivery, ACP
startup and descendant cleanup, the installed command shim, forbidden-marker
scans, and the packed artifact. Before claiming support for an individual
Windows agent profile and mode, run its exact real-agent qualification on
Windows and record the result.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md) and does not authorize client-side
compatibility behavior.
