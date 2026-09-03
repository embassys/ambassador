# Current work

The Ambassador delivery cutover and zero-configuration startup are implemented.
The deterministic suite covers guided registration, complete-message webhook
delivery, direct ACP v1 delivery, correlated action-result submission,
automatic central acknowledgement, restart loss, bounded state, internal
credential-key custody, and packed-package installation. Completed design and
behavior live in the architecture, protocol, and ADRs rather than this plan.

## Post-release qualification

The user explicitly approved `@embassys/ambassador@0.2.6` and the corrective
0.2.7 release on 2026-09-03 before completion of the real-agent matrix. This
exception to ADR 0015 is not evidence that the remaining cases passed. Complete
and record the following work after the release. The published 0.2.7 registry
artifact and installed CLI have now been independently verified; completed
artifact checks are recorded in [Live central qualification](live-qualification.md).

- Complete the remaining four opt-in real-agent profile/mode cases with exact
  authenticated profiles:
  OpenClaw 2026.8.1,
  `@agentclientprotocol/claude-agent-acp` 0.73.0, and Gemini CLI 0.58.0.
  OpenClaw must pass webhook and direct delivery; Claude Code and Gemini CLI
  must pass direct delivery.
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
- Hermes Agent 0.20.5 passed webhook with the published 0.2.7 artifact and
  direct with the candidate that became Ambassador 0.2.8. Do not claim
  published 0.2.7 direct support.
  Hermes 0.21.0 still has only its contract and ACP startup probe, so complete
  its real-model MCP round trip if that exact version remains in a future
  release candidate.
- The isolated ACP initialization probes already pass for Codex ACP 1.8.0,
  Claude Agent ACP 0.73.0, and native Gemini CLI ACP 0.58.0. The pinned
  OpenClaw and Hermes images also pass their version and ACP startup probes.
  These probes do not replace an authenticated prompt and observed Ambassador
  MCP call.
- Record only the safe version and pass/fail evidence produced by
  `scripts/qualify-agents.mjs`. Do not record prompts, messages, credentials,
  secrets, paths containing user data, or provider output.
- Replace remaining source-reviewed version labels in the getting-started
  guides only when their exact real-agent qualification passes.

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
