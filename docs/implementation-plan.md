# Current work

The Ambassador delivery cutover and zero-configuration startup are implemented.
The deterministic suite covers guided registration, complete-message webhook
delivery, direct ACP v1 delivery, correlated action-result submission,
automatic central acknowledgement, restart loss, bounded state, internal
credential-key custody, and packed-package installation. Completed design and
behavior live in the architecture, protocol, and ADRs rather than this plan.

## Release 0.2.7

- Merge the approved release change after CI passes.
- Confirm npm trusted publishing produced `@embassys/ambassador@0.2.7`.
- Smoke-test the documented `npx --yes @embassys/ambassador@0.2.7 start`
  command without an Ambassador token or environment variable.

## Post-release qualification

The user explicitly approved `@embassys/ambassador@0.2.6` and the corrective
0.2.7 release on 2026-09-03 before completion of the real-agent matrix. This
exception to ADR 0015 is not evidence that the remaining cases passed. Complete
and record the following work after the release:

- Complete the remaining six opt-in real-agent cases with exact authenticated
  profiles:
  OpenClaw 2026.8.1, Hermes Agent 0.21.0,
  `@agentclientprotocol/codex-acp` 1.8.0, backed by Codex 0.152.1,
  `@agentclientprotocol/claude-agent-acp` 0.73.0, and Gemini CLI 0.58.0.
  OpenClaw and Hermes must pass webhook and direct delivery; Codex, Claude
  Code, and Gemini CLI must pass direct delivery. Codex direct passed the
  complete live correlated-result flow on 2026-09-03 against packed candidate
  `7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`
  and reviewed central revision
  `ac3f7a6e33829eb80301c7944f611d29cc2499b5`: the authenticated target called
  `respond_to_permission` and `submit_action_result`, and the controlled
  requester received the correlated `action_response`. The run used an
  isolated preapproval policy, not an interactive user prompt. Repeat it on a
  supported Node release; the installed 24.14.0 runtime was below the 24.19.0
  floor. Its isolated credential copy was removed after the run.
- The isolated ACP initialization probes already pass for Codex ACP 1.8.0,
  Claude Agent ACP 0.73.0, and native Gemini CLI ACP 0.58.0. The pinned
  OpenClaw and Hermes images also pass their version and ACP startup probes.
  These probes do not replace an authenticated prompt and observed Ambassador
  MCP call.
- Record only the safe version and pass/fail evidence produced by
  `scripts/qualify-agents.mjs`. Do not record prompts, messages, credentials,
  secrets, paths containing user data, or provider output.
- Replace the remaining source-reviewed version labels in the getting-started
  guides with real-agent qualification evidence after all ten cases pass.

Windows remains unsupported under ADR 0033. Optional central service work
remains in [Central follow-ups](central-follow-ups.md) and does not authorize
client-side compatibility behavior.
