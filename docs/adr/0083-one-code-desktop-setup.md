# 0083. One-code desktop setup

Status: accepted, 2026-09-14. The owner requested implementation after API
issue 21 closed. This amends ADRs 0072, 0077 and 0082.

Both welcome actions use owner email sign-in. After that single verification,
Connect creates or adopts the agent through `POST /api/owner/agents` with an
empty body. The server derives the email from the owner session. Validate the
returned verified identity and refresh the authoritative roster before setup.
Repeating creation after response loss is safe under this route's identity
contract; it never invokes legacy registration or sends another email code.

Use the existing reviewed device-selection and private execution-token install
flow. An explicit Connect authorizes initial setup on this device. If the
current review shows another execution device, show that move for confirmation.
Re-read the execution epoch before submitting; stale reviews require another
attempt. Stop and lock the local instance before transfer and token installation.
Do not overwrite a different local identity or interrupt an unrelated CLI.
Keep unfinished setup visible and resumable after failures or restart.

Choose the fixed provider, install its existing connection and discovery skill,
then run the existing read-only connection check. Account-only access remains
available. Owner and execution credentials stay in separate private custody;
the renderer sees only public state. Public CLI registration is unchanged.

Regressions precede implementation and cover response loss, repeat creation,
restart, wrong identity, stale account/device review, incomplete token install
and no second email. Qualify deployed API setup and native onboarding with a
real provider. No dependency, API code or release is included.
