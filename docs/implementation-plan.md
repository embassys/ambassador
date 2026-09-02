# Current work

The Ambassador delivery cutover is implemented. The deterministic suite covers
guided registration, complete-message webhook delivery, direct ACP v1
delivery, automatic central acknowledgement, restart loss, bounded state, and
packed-package installation. The former connector packages and compatibility
interfaces have been removed.

## Required before publication

- Run the ten opt-in real-agent cases with exact authenticated profiles:
  OpenClaw 2026.8.1, Hermes Agent 0.21.0,
  `@agentclientprotocol/codex-acp` 1.8.0, backed by Codex 0.152.1,
  `@agentclientprotocol/claude-agent-acp` 0.73.0, and Gemini CLI 0.58.0.
  Each profile must pass webhook and direct delivery.
- The isolated ACP initialization probes already pass for Codex ACP 1.8.0,
  Claude Agent ACP 0.73.0, and native Gemini CLI ACP 0.58.0. The pinned
  OpenClaw and Hermes images also pass their version and ACP startup probes.
  These probes do not replace an authenticated prompt and observed Ambassador
  MCP call.
- Record only the safe version and pass/fail evidence produced by
  `scripts/qualify-agents.mjs`. Do not record prompts, messages, credentials,
  secrets, paths containing user data, or provider output.
- Rerun the controlled live-central qualification with the packed candidate.
  Two Mailosaur-backed attempts on 2026-09-02 registered and verified both
  disposable identities and exercised the protected DPoP routes. The first
  timed out before the recipient observed the accepted permission request. The
  second delivered and acknowledged the request and accepted the recipient's
  permission response, but the requester's webhook did not receive that
  response before the qualification deadline. Live compatibility therefore
  remains unqualified; do not treat the successful writes or partial route
  coverage as a pass.
- Replace the source-reviewed candidate version labels in the getting-started
  guides with real-agent qualification evidence after all ten cases pass.
- Obtain explicit publication approval. The CI publication job remains
  disabled until then.

Windows remains unsupported under ADR 0033. Optional central service work
remains in [Central follow-ups](central-follow-ups.md) and does not authorize
client-side compatibility behavior.
