# Current work

The gateway REST integration is implemented and live-qualified. Completed work
belongs in the architecture, protocol, tests, and Git history, not in this
plan.

## Provider connector redesign

The next engineering task is to replace the connector's obsolete central
conversation workflow with one based on current permission and action
messages.

Before changing production connector code:

1. Decide which message types may invoke a provider.
2. Define which local actor makes permission decisions.
3. Define how an action request becomes provider input and how the result is
   represented through the current REST tools.
4. Amend ADRs 0024, 0029, and 0030 where their conversation assumptions no
   longer apply.
5. Replace the affected connector tests before implementation.

Keep the existing process isolation, local policy limits, credential
separation, content-free durable state, and uncertain-provider-outcome rules.
Do not add central credentials to a connector or provider credentials to the
gateway.

## Provider qualification

After the redesign passes fixture and package tests:

- run the real Codex qualification;
- run the real Claude Code qualification; and
- decide separately whether to propose another Gemini interface.

No provider has a live-central support claim until its new workflow passes
qualification.

## Distribution

The current source has passed gateway live qualification, but publication is
a separate decision. Before publishing:

- rerun Linux and macOS CI and package installation;
- rerun the controlled live qualification against the current server;
- review dependency and signature audits;
- update the user setup guides with the exact package version; and
- obtain explicit publication approval.

Windows remains unsupported under ADR 0033.

## Central service work

Optional server changes are tracked in [Central follow-ups](central-follow-ups.md).
They do not block the gateway or authorize client-side compatibility code.
