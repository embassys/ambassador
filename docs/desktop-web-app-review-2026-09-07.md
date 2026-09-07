# Web app and server review for the desktop app

Reviewed 2026-09-07 after the owner shared the web app repository. This updates
parts of the earlier [API review](desktop-api-review-2026-09-07.md). It does not
qualify new desktop API integrations or authorize server changes.

Sources are [web_app a9cb3d3](https://github.com/embassys/web_app/tree/a9cb3d3b1c9ead3be0f9881cf8ae514a4046dde4)
and [agent2agent a8c0e77](https://github.com/embassys/agent2agent/commit/a8c0e77e0a5bb6897ed842a7288a458124fd298c).
The web app README still says it is not deployed. The deployment files and
read-only live checks show a newer state: `/api/app/health` returned 200 with
`database: ok`, `/api/app/me` returned 401 without credentials, and `/app/`
served the sign-in page at `https://mcp.embassys.ai`. These checks establish
reachability only. They do not prove authenticated flows or visible push delivery.

## What is available now

| Area | Current source contract | Desktop implication |
| --- | --- | --- |
| Returning-owner sign-in | `/api/app/login/request`, `/login/verify`, `/session/refresh`, `/session/signout`, `/session/signout_all`, `/me` | Reuse this owner realm instead of inventing another login API. Email must already match one existing agent. It does not enroll or restore an executor. |
| Owner requests | `/api/app/requests` returns pending permission and input requests, with owner-authenticated decision and answer endpoints | A useful foundation for the desktop Attention screen. Exact options, full context and lost-response recovery still need work below. |
| Permissions | Granted/received lists, scopes, expiry, remaining uses and `/permissions/{id}/revoke` | Much more than the old agent permission snapshot. A conditional update authorizes the grantor and queues revocation in the same transaction. |
| Communication history | `/api/app/communications` lists central messages in both directions | Keep this distinct from the local agent conversation archive. Message transport status is not a completed conversation or proof of display. |
| Browser push | VAPID key, subscribe/unsubscribe, device list and fixed test notification; a service worker refreshes Requests on click | Reuse the event semantics and generic notification copy. Browser subscriptions do not provide native APNs/WNS registration or an Electron delivery guarantee. |

The deployed design uses a separate app service behind the same public origin.
The server commit also allows mounting the app router when its modules are
present. Preserve the separation between owner observation and the execution
receiver. Never use the owner screens as another consumer of `poll_messages`.

## What to adopt

Use the web app's organization: requests that need an answer first, current
permissions split by direction, central message history separately, and account
controls with notification diagnostics. Its notification click reloads pending
requests even if that screen is already open. The desktop should do the same.
Do not claim display success when a push service only accepted the notification.

Use the existing owner session endpoints once qualified. The desktop host should
hold access and refresh tokens in separate encrypted owner custody, pass only
public status through IPC, and serialize refresh. Do not copy the web app's
localStorage refresh-token storage into the Electron renderer. Owner sign-out
and agent Stop are different operations. The current API has no executor binding
to disable at owner sign-out, so that proposed desktop behavior remains blocked.

Keep the native Electron shell, local server controls and local archive. A remote
webview with privileged IPC would make remote page code part of the local
server's trust boundary and would not improve native controls. The existing web
app can be used in a regular browser at [Embassys](https://mcp.embassys.ai/app/)
while the desktop owner flow is qualified.

## Remaining contract gaps

- The owner login session is bound to an existing agent row, not a device key or
  executor lease. It cannot recover a missing agent DPoP key/token, create a new
  owner, enumerate multiple owned agents or fence two executors. Keep issues
  [2](https://github.com/embassys/agent2agent/issues/2) and
  [7](https://github.com/embassys/agent2agent/issues/7) open.
- Requests cap each kind at 200 and history lists cap at 200, with no cursor.
  The returned request `total` counts only returned rows. Do not label these as
  complete counts or complete history. Pending permission details omit the
  original reason; input list rows omit the source message/call correlation.
  There is no snapshot revision or per-request recoverable mutation ID.
- Decisions and answers share database transactions with the email path, which
  is useful race protection. But a response lost after commit cannot be recovered
  by replay: a later call returns a conflict, and pending-list removal alone
  does not identify the actor or answer. Do not auto-retry a decision, answer,
  revocation or refresh after an uncertain response. These remain issues
  [4](https://github.com/embassys/agent2agent/issues/4) and
  [8](https://github.com/embassys/agent2agent/issues/8).
- The web UI has hard-coded permission menus and falls back to Accept/Deny for
  an unknown menu name. Do not adopt that fallback. Unknown options must remain
  unavailable until the server supplies an authoritative menu. Provider input
  buttons should continue to use their exact supplied labels and values.
- Revocation emits a new `permission_revoked` payload. ADR 0069 now handles it
  explicitly, rejects undispatched matching work and emits a desktop permission
  notification. Fixture and controlled live checks pass, including the revoked
  permission-list record. Completed and uncertain submissions are not replayed,
  and revocation never creates a permission request automatically. Full audit
  history and recoverable owner mutations remain in
  [issue 9](https://github.com/embassys/agent2agent/issues/9).
- Browser push is not a recoverable owner event stream, and there is no native
  APNs/WNS token contract. Qualify browser push separately and retain native
  delivery in [issue 10](https://github.com/embassys/agent2agent/issues/10).
- The agent server commit leaves `poll_messages`, message claiming,
  acknowledgement and submission recovery unchanged. The earlier loss and
  unbounded listener-acquisition risks remain. New email action types are catalog
  additions; continue using exact catalog names and schemas without mappings.
- The web repo includes an explicit token-realm guard patch and corresponding
  tests, but that patch is absent from the reviewed server `auth.py`. The current
  JWT library rejects a correctly formed app audience in the agent verifier;
  the missing guard concerns tokens with other app claims and no audience.
  Qualify both positive agent authentication and negative owner/agent realm
  cases against the exact deployed pair before integrating owner credentials.

## Next integration order

Update: ADR 0068 implements steps 1–2; ADR 0069 completes step 4. Controlled live owner login, all read-only
views, session rotation, restart and sign-out passed through the packaged worker.
Native Mac account entry and view checks also passed. See the final evidence in
[the desktop plan](desktop-app-plan.md). The contract findings above still apply.

1. Finish and qualify the approved desktop setup helpers and log policy.
2. Qualify owner login, refresh, sign-out and bounded read-only snapshots against
   the existing app endpoints with disposable identities. Keep owner state
   independent of the local executor's registration and selected instance.
3. Resolve the missing request context, exact menus, pagination and uncertain
   mutation handling before enabling the desktop decision controls required by
   ADR 0064. Add email/app race and revoked/expired/inactive-provider cases.
4. Add explicit `permission_revoked` handling with fixture and controlled live
   tests. Verify the grantee sees revoked status without replaying any action.
5. Qualify browser notification receipt separately from native desktop push.
   Retain the current running-app OS notifications until native transport and
   signed distribution are available.

No central or web app files were edited. No live login, decision, revocation,
message submission or push was issued as part of this read-only review.
