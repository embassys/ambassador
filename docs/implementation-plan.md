# Current work

There is no open product implementation item. The ADR 0047 reliability
cutover, stable MCP catalog, encrypted unanswered-action inbox, and built-in
Claude CLI bridge are implemented and qualified. ADR 0048 removes the
Claude-specific login preflight and leaves authentication to the official CLI.
Release evidence belongs in [Delivery qualification](qualification.md), not in
this plan.

## Later qualification

Before the next release, repeat the real Claude qualification with the native
authentication method selected for that run. Record only the authentication
category and observed result. Do not capture credentials, and do not claim that
programmatic usage consumes a particular subscription allowance.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
