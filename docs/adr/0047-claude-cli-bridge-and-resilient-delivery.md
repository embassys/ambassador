# 0047 Claude CLI bridge and resilient local delivery

Status: accepted

Date: 2026-09-04

## Problem

The package-owned `@agentclientprotocol/claude-agent-acp` adapter could start
and report the user's Claude subscription login, but its Agent SDK request
still rejected that login and required separate API authentication. Asking the
user for an API key would violate Ambassador's provider-credential boundary.
A failed direct child could also terminate the foreground Ambassador process,
and MCP clients did not consistently refresh a tool catalog that changed after
verification.

## Decision

- Keep the working package-owned `@agentclientprotocol/codex-acp` adapter.
  Writing another Codex adapter would add an unnecessary protocol and process
  boundary without fixing the observed Claude failure.
- Remove `@agentclientprotocol/claude-agent-acp`. Ambassador owns a small ACP
  v1 bridge for Claude Code and launches that bridge with its Node runtime. The
  bridge launches the separately installed `claude` command without a shell.
- Before accepting a session, the bridge runs the fixed `claude auth status`
  check and requires an ordinary `claude.ai` login. It does not accept, copy,
  or forward Anthropic API-key or token environment variables.
- Each incoming message uses a non-persistent headless Claude invocation with
  only the exact loopback Ambassador MCP endpoint and the bounded Ambassador
  tools required for permission and action handling. Provider stderr and model
  output remain bounded and are not returned or logged.
- Advertise one stable MCP tool catalog before and after enrollment. Calls to
  protected tools before verification fail with `not_enrolled`; calls to
  enrollment tools afterwards fail with `already_enrolled`. Do not depend on
  `notifications/tools/list_changed` for correctness.
- A local agent or webhook delivery failure pauses that relay and prints one
  bounded operator message, but leaves the foreground MCP server running. A
  central, credential, state, or listener failure remains fatal. The owner
  restarts Ambassador after correcting the local delivery problem.
- Full request, response, and provider tracing was permitted only for the
  explicitly approved second live qualification. It and the temporary
  multi-instance environment overrides were removed after the successful run;
  neither is part of the release interface or artifact.

## Consequences

Claude Code users need the official CLI installed and signed in, but no ACP
adapter or API key. Ambassador still speaks ACP v1 internally, so the direct
delivery client and its message-custody rules do not fork by provider. Codex
continues through its established adapter.

The Claude bridge is deliberately narrower than a general Claude Code session.
It exists only to process an Ambassador wake with Ambassador tools. An action
that needs information unavailable in that background turn remains in the
encrypted pending-action inbox for a later user-driven MCP chat.

Keeping MCP alive after a local delivery failure lets the owner inspect and
repair enrollment state. It does not make a consumed central message
redeliverable; that requires the server work listed in
`docs/central-follow-ups.md`.

## Approval

The user approved the bridge, stable catalog, bounded relay behavior, a second
logged end-to-end run, removal of diagnostic tracing after that run, and a
follow-up release on 2026-09-04.
