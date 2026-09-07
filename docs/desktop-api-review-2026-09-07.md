# Desktop API capability review

Reviewed on 2026-09-07 against server `main` at
[`708f205b`](https://github.com/embassys/agent2agent/tree/708f205bfaee5010eb86fcfae55967fb5d02071c)
and the deployed [OpenAPI document](https://mcp.embassys.ai/openapi.json).
GitHub lists only `main`, with no open pull requests. The latest commit is from
September 4. The deployed health endpoint reports healthy but exposes no build
revision, so matching the route/schema inventory does not prove identical code.
This review used public API-description and health reads plus source inspection.
It did not register an identity, submit a decision or exercise authentication.

## Existing capabilities

| App need | What exists | Remaining limitation |
| --- | --- | --- |
| Email/code setup | `register_agent`, `verify_email` and `resend_verification` | First-time agent enrollment works. Verified addresses cannot sign in again through these endpoints. No separate owner session or device binding. |
| Show permissions | `get_my_permissions` lists records where the agent is grantor or grantee, including pending records, scope, status and dates | A basic agent-scoped read-only view is possible. This is not complete owner audit history: no pagination, offered decision menu, reason, remaining uses or revocation contract. |
| Inspect a question | `get_human_input_status` reads a known request ID and its options/answer for the requesting agent | No list of all owner questions or owner event cursor. Ambassador does not currently integrate this status route. |
| Submit permission decisions | `permission_decision` shares the email form's decision implementation | Requires the single-use credential from the email. The current agent permission list does not return it. |
| Submit owner answers | `human_input_response` shares the email form's answer implementation | Also requires the email credential, not a signed-in owner session. |
| Agent-authenticated grant/deny | `respond_to_permission`, `grant_permission` and `deny_permission` remain published | Legacy implementations do not share the email transaction, exact one-use decisions or email-token invalidation. They are unsuitable replacements for the accepted app approval flow. |
| OAuth | Central MCP connector authorization routes exist | The page calls first-time `verify_email` as its login step. It does not solve returning-user sign-in. Source also lacks verification binding in `oauth/complete`; it must not become desktop owner authentication. |
| Streaming | Central `/mcp` exposes SSE; local Ambassador already supports held MCP responses | The mounted central SSE generator sends initialization, tool descriptions and heartbeats. It does not publish a durable owner inbox feed or deliver APNs/WNS push. |

The authoritative route implementations are in
[`main.py`](https://github.com/embassys/agent2agent/blob/708f205bfaee5010eb86fcfae55967fb5d02071c/main.py),
[`models.py`](https://github.com/embassys/agent2agent/blob/708f205bfaee5010eb86fcfae55967fb5d02071c/models.py),
[`mcp_oauth.py`](https://github.com/embassys/agent2agent/blob/708f205bfaee5010eb86fcfae55967fb5d02071c/mcp_oauth.py)
and the mounted
[`mcp_sse_server.py`](https://github.com/embassys/agent2agent/blob/708f205bfaee5010eb86fcfae55967fb5d02071c/mcp_sse_server.py).

## Implication for the app

Saying all account and permission UI is blocked by missing endpoints was too
broad. The current API can support a smaller development experience: first-time
agent setup in an app form and an explicitly agent-scoped permission/status view.
The form would use the existing encrypted credential path and a reviewed executor
chosen by the user, without impersonating an MCP client. It must say registration,
not promise returning-user login or recovery after Clean.

The user subsequently approved this smaller flow. ADR 0065 amends ADR 0064's
requirement to wait for separate owner authentication before providing these
development features. Implementation is tracked in the desktop plan. It must not turn an
agent credential into authority for human decisions. Running-app notifications
for locally observed work are also distinct from server push and could be built
without claiming a complete remote owner inbox.

Returning-owner sign-in/recovery, secure app decisions, complete audit/revocation,
durable owner events and remote push still require server work. Keep issues
[7](https://github.com/embassys/agent2agent/issues/7),
[8](https://github.com/embassys/agent2agent/issues/8),
[9](https://github.com/embassys/agent2agent/issues/9) and
[10](https://github.com/embassys/agent2agent/issues/10) open. Recovery issues 1–6
are not resolved by the existing OAuth or SSE routes. No API code changed.
