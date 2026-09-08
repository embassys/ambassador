# 0072. Account-first desktop onboarding

Status: accepted, 2026-09-08, following the owner's request for Log in or Register,
then the easiest agent setup, then the rest of the app.

Open signed-out windows with a focused welcome screen. Hide the main navigation,
instance selector, logs and activity until onboarding is complete. Keep server
controls reachable for existing running installations. Signing out must return
to this screen without stopping the server or consuming pending work.

Registration collects email and code before asking for an executor. The existing
central enrollment API needs only email, so the desktop can defer its local
provider selection. Record that unfinished setup explicitly. Do not start the
receiver, dispatch work, accept business tools or infer a provider until the owner
selects a reviewed executor. A restarted app or matching CLI preserves this state.
MCP-origin registration retains its existing fixed-provider requirements.

Owner login remains separate from the agent's DPoP credential. Central currently
requires a second email code for a newly registered owner to log in. Explain that
step, reuse the email in the form and never reuse the registration code as an
owner code. No token crosses realms. Existing-account login cannot recover a lost
agent credential. Offer account-only access when local setup cannot be completed.

After login, guide setup one agent at a time. Lead with the existing guarded
connection button; keep addresses and manual instructions collapsed. Show saved
configuration separately from a live provider connection. Finish or explicitly
defer setup before showing Requests, Permissions, Messages and Account. Remember
that choice per account and selected installation, not as authentication state.
Expired login, account changes and instance changes re-evaluate the gate.

Use existing React, CSS, private IPC and central endpoints. No dependency, CLI
flag, central API change or release is authorized. Update issue 7's existing
account lifecycle contract for the extra-code limitation if needed.

Tests cover registration without a provider, restart before selection, immutable
provider selection, uncertain enrollment, no dispatch before setup, login and
sign-out gating, stale account completion, setup deferral and native first launch.
