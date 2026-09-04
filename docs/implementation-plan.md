# Current work

There is no open product implementation item. The ADR 0047 reliability
cutover, stable MCP catalog, encrypted unanswered-action inbox, and built-in
Claude CLI bridge are implemented and qualified. ADR 0048 removes the
Claude-specific login preflight and leaves authentication to the official CLI.
ADR 0049 removes Claude's safe and strict MCP isolation so resource-backed
actions can use normal provider-configured tools. The other direct profiles
already retain their native tool behavior.
Release evidence belongs in [Delivery qualification](qualification.md), not in
this plan.

## Later qualification

Before the next release, repeat the real Claude qualification with the native
authentication method selected for that run and its user-scope Ambassador MCP
entry. Prove that the background turn can call that normally configured MCP
and complete the action automatically. Record only the authentication category
and observed result. Do not capture credentials, and do not claim that
programmatic usage consumes a particular subscription allowance.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
