# Current work

The Ambassador delivery cutover and zero-configuration startup are implemented.
The deterministic suite covers guided registration, complete-message webhook
delivery, direct ACP v1 delivery, correlated action-result submission,
automatic central acknowledgement, restart loss, bounded state, internal
credential-key custody, and packed-package installation. Completed design and
behavior live in the architecture, protocol, and ADRs rather than this plan.

Published Ambassador 0.2.9 corrects the version policy under ADR 0041. The
0.2.10 candidate adds internally generated encrypted webhook secrets, the
`ambassador webhook-secret` command, and the shipped OpenClaw webhook receiver.
Exact known MCP client names still select fixed profiles, and exact ACP v1
agent names still protect direct initialization, but reported client and agent
versions do not gate either step. Ambassador tries the fixed contract and
surfaces an actual startup, initialization, session, or delivery failure. The
candidate's local checks and four-case Hermes/OpenClaw live-central matrix have
passed. Publication and registry-artifact verification remain pending.

## Remaining qualification

The user explicitly approved `@embassys/ambassador@0.2.6` and the corrective
0.2.7 release on 2026-09-03 before completion of the real-agent matrix. This
exception to ADR 0015 is not evidence that the remaining cases passed. Complete
and record the following work after the release. The published 0.2.7 registry
artifact and installed CLI have now been independently verified; completed
artifact checks are recorded in [Live central qualification](live-qualification.md).

- Complete the remaining two opt-in real-agent profile cases with authenticated
  installations: Claude Code direct and Gemini CLI direct.
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
- The isolated ACP initialization probes already pass for Codex ACP 1.8.0,
  Claude Agent ACP 0.73.0, and native Gemini CLI ACP 0.58.0. OpenClaw and
  Hermes also pass their version and ACP startup probes.
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
