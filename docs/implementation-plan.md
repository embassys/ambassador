# Current work

The Ambassador delivery cutover is implemented. The deterministic suite covers
guided registration, complete-message webhook delivery, direct ACP v1
delivery, automatic central acknowledgement, restart loss, bounded state, and
packed-package installation. The former connector packages and compatibility
interfaces have been removed.

## Required before publication

- Run the four opt-in real-agent cases with already installed and authenticated
  OpenClaw 2026.8.1 and Hermes Agent 0.21.0:
  OpenClaw webhook, OpenClaw direct, Hermes webhook, and Hermes direct.
- Record only the safe version and pass/fail evidence produced by
  `scripts/qualify-agents.mjs`. Do not record prompts, messages, credentials,
  secrets, paths containing user data, or provider output.
- Rerun the controlled live-central qualification with the packed candidate.
- Replace the source-reviewed candidate version labels in the getting-started
  guides with real-agent qualification evidence after all four cases pass.
- Obtain explicit publication approval. The CI publication job remains
  disabled until then.

Windows remains unsupported under ADR 0033. Optional central service work
remains in [Central follow-ups](central-follow-ups.md) and does not authorize
client-side compatibility behavior.
