# Current work

Phase 3B is complete. ADR 0050's common ACP policy, public Codex and Claude
adapters, persistent session lifecycle, session commands, verbose diagnostics,
provider-configured MCP use, retention cleanup, documentation, and deterministic
coverage are implemented. A clean packed Codex-to-Claude live run also passed
the deployed email-decision permission flow, all public CLI commands, and the
correlated action-result round trip. Evidence is in
[Delivery qualification](qualification.md).

ADR 0051's encrypted received-action-result storage is implemented. ADR 0052
replaces the three separate inbox views with `get_inbox`, which combines
unanswered action calls and unread action results. ADR 0054 replaces agent-side
Embassys permission decisions with the deployed human email flow and updates
the current request schema and live qualification. Verbose ACP logging reports
the available-command count without printing the command catalog or its
descriptions.

ADR 0055's implementation replaces automatic ACP tool approval with
`get_human_input`. The deterministic gateway test proves that the ACP request
remains pending, the local agent's own owner receives the question, the answer
is received as a correlated `human_input_response`, unrelated messages are
preserved, the control response is not prompted to the provider, and all
messages are acknowledged in order.

ADR 0053's live session inspection is implemented. `sessions list` and
`sessions show` use the foreground process while it runs; destructive session
commands remain stopped-only.

The controlled live Codex-to-Claude qualification of ADR 0055 passed against
the deployed own-human input endpoint. The remaining work is a separately
approved release. Version 0.2.17 remains published under the npm `latest` tag.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
