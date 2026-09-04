# Current work

There is no open product implementation item. The ADR 0047 reliability
cutover, stable MCP catalog, encrypted unanswered-action inbox, and built-in
Claude CLI bridge are implemented and qualified. ADR 0048 removes the
Claude-specific login preflight and leaves authentication to the official CLI.
ADR 0049 removes Claude's safe and strict MCP isolation so resource-backed
actions can use normal provider-configured tools. The other direct profiles
already retain their native tool behavior.
The post-ADR 0049 candidate passed two consecutive real-Claude live runs, a
real-Codex live run, and a clean combined Codex-to-Claude direct exchange
against the same packed archive.
Release evidence belongs in [Delivery qualification](qualification.md), not in
this plan.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
