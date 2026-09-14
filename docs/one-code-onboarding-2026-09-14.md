# One-code desktop onboarding, September 14

Implemented under [ADR 0083](adr/0083-one-code-desktop-setup.md). The deployed
`POST /api/owner/agents` contract and the corresponding server source on main
were reviewed before implementation. Both welcome actions now use owner sign-in;
Connect creates or adopts the verified agent at that same address, then uses the
existing guarded device assignment and private execution-token installation.
The CLI's email enrollment flow is unchanged.

## Native journey

A fresh isolated development app completed onboarding on this Mac against
`https://mcp.embassys.ai`, using a disposable mailbox and installed Claude Code.

1. Register opened the email form and requested one owner sign-in code.
2. That verification opened the four-agent selection screen.
3. Connect Claude Code created the verified agent, selected this device and
   installed its execution credential without another email.
4. The connection review installed the discovery skill and reused the existing
   matching MCP entry. The provider requested approval for a read-only
   `get_my_permissions` check. A one-time Yes completed that exact check.
5. The native app displayed **Claude Code is connected** with the matching
   email, then opened the workspace.
6. Quit and relaunch preserved the account, registration and completed onboarding.
7. The app removed its test-installed skill, kept the original MCP configuration
   unchanged, signed out and quit. Temporary keep-awake processes ended with it.

The captured logs confirm one `start_sign_in`, one `verify_sign_in`, one owner
agent creation, and no `register_agent` or `verify_email` calls during this
journey. The email code was absent from both diagnostic logs. Twelve native
screenshots and a sanitized event record are retained in
`.build/one-code-onboarding/`. The final email-form capture removes redundant
sign-in text; earlier journey captures show the form before that copy adjustment.
The test mailbox was cleared. No provider credentials were copied or modified.

## Recovery and regression evidence

Two additional deployed tests deliberately discarded successful owner-agent
creation responses, reopened encrypted account state and repeated the request.
Both returned the original verified agent with `created: false`, then completed
reviewed device selection and private credential installation. One started with
no agent; the other adopted an unfinished legacy registration, preserving its
central ID. Neither used an agent verification code. Disposable local stores and
verification emails were removed afterward.

Deterministic tests cover signed-out and stale contexts, extra email arguments,
wrong identity, unverified records, inconsistent device status, ownership
conflicts, response loss, restart, incomplete local installation and review
expiry. Provider setup tests cover initial assignment, explicit confirmation
before moving another device, and rechecking a saved credential's device and
epoch before reusing it. An old execution epoch cannot skip device setup merely
because the credential has not expired.

The complete repository check passed 590 tests with seven expected skips. All
46 desktop artifact/render tests passed, as did desktop typecheck, the production
build and the bundled Node/SQLite/ACP/MCP worker verification. The epoch regression
failed against the earlier implementation and passed after the fix.

This qualifies native Claude onboarding on this Mac, not other native providers,
Windows/Linux UI, signed distribution or remote push. The added epoch comparison
has deterministic coverage; it does not add a new provider operation. No central
code, dependency, version or release changed.
