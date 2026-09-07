# 0068 Owner sign-in and account views with the deployed app API

Status: accepted

Date: 2026-09-07

The user approved proceeding with owner login and account views after the
[web app review](../desktop-web-app-review-2026-09-07.md). Use the existing
`/api/app` routes at the fixed central origin. This implements the available
part of ADR 0064; it does not authorize server changes or publication.

One separate bundled Node worker holds the owner session for this installation.
Its encrypted account directory is outside all gateway instances. No owner
token reaches the renderer, gateway, MCP, provider configuration or diagnostics.
The renderer receives a bounded public account snapshot and read-only request,
permission and central message views through validated private IPC. Instance
selection, Stop and Clean do not change this account. Sign-out removes the local
owner session and asks central to revoke that session; it does not stop agents.
The current API cannot revoke an executor binding on owner sign-out.

Persist a rotation/verification uncertainty marker before sending a one-use
credential. Serialize refresh and never repeat an uncertain exchange after
timeout, process loss or a failed local save. A new email code is the recovery
path for the owner session. It does not recover an agent identity or DPoP key.
Commit local sign-out before its remote call; report when remote revocation
cannot be confirmed. Do not automatically replay sign-out or sign out other
devices. Reject commands from an earlier account context, and discard stale
view responses after sign-out or account changes.

Keep owner data reads independent of the execution receiver. They never use
`poll_messages`, consume results or acknowledge delivery. Lists are bounded
snapshots with a visible server limit, not complete history or account totals.
Show request questions/options as text without offering decisions. Missing exact
permission choices, context and recoverable mutations still block in-app
approvals, answers and revocation. The ordinary system browser can open the fixed
web app address; no owner token is included in that link.

Account views refresh on opening and explicit refresh. No durable owner feed or
remote desktop push is claimed. Keep the existing running-app notifications.
Use the existing encrypted credential format, crypto, SQLite lock and typed
validation libraries. No dependency or CLI change is needed.

Authentication requests and responses log metadata only. Read views log only
validated, credential-redacted fields under the account's separate diagnostics
folder. The app's Account logs control opens that folder. The existing desktop
rotation and retention policy applies. No access token, refresh token or code
is included in diagnostic bodies, even in development.

Tests precede implementation and cover code errors/cooldowns, token realms,
serialized refresh, unknown outcomes and restart, offline reads, sign-out,
account/instance isolation, malformed and oversized data, private IPC, native
form behavior and controlled live login/read/sign-out qualification.
