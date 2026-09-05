# Current work

ADR 0056 is implemented and qualified. Indexed encrypted stores allow 1 GiB
each, `get_inbox` pages safely, receipt capture covers approval polling, and
saved outbound intent dispatches the exact requested payload after a grant.
ACP sessions reuse context per remote identity while tracking each message and
action independently. Idle cleanup runs in bounded background batches. Existing
state and migration are outside the approved scope.

The deterministic suite, clean-installed live REST flow, real two-turn context
recall with all four providers, and combined real Codex-to-Claude action round
trip passed. The combined run also verified peer-session reuse and running
session reads on both gateways. OpenClaw uses its reviewed load path to restore
its gateway mapping. See [Delivery qualification](qualification.md)
for versions, artifact digests, and the limits of these checks.

PR 37 merged and version 0.2.18 was published on 2026-09-05. All six provider
delivery modes and every main-branch release gate passed, including Windows.
The independently downloaded npm artifact matched the qualified candidate and
passed clean-install, runtime, artifact, vulnerability, and signature checks.
The user deferred further Windows fixes to a separate pull request; no further
Windows change or release-gate exception was needed after the merge.
Approval-option mapping remains deferred by the user; central recovery remains
server work.

Phase 3B is complete. ADR 0050's common ACP policy, public Codex and Claude
adapters, persistent session lifecycle, session commands, verbose diagnostics,
provider-configured MCP use, retention cleanup, documentation, and deterministic
coverage are implemented. A clean packed Codex-to-Claude live run also passed
the deployed email-decision permission flow, all public CLI commands, and the
correlated action-result round trip. Evidence is in
[Delivery qualification](qualification.md).

ADR 0051's encrypted received-action-result storage is implemented. ADR 0052
replaces the three separate inbox views with `get_inbox`, which combines
unanswered action calls, unread action results, and ADR 0056's outbound status.
ADR 0054 replaces agent-side
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
the deployed own-human input endpoint. Version 0.2.18 is published under the
npm `latest` tag.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
