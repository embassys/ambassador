# Client delivery and qualification

This describes the unpublished ADR 0061 candidate. Configuration does not prove
that a client displayed a result. Evidence belongs in [qualification](qualification.md).

| Client | Implemented path | Current qualification |
| --- | --- | --- |
| OpenClaw | Foreground wait; experimental hook bridge to the captured logical session key | Real ACP action flow, two-conversation history routing and reconnect pass; immediate desktop display remains unqualified |
| Hermes CLI/gateway | Foreground wait and durable inbox/check | Real ACP action flow passes; native return deferred pending a trusted gateway routing key and idle-only injection |
| Codex | Foreground wait and later check | Real ACP action flow and 600-second SDK/HTTP wait pass; actual Codex foreground conversation still requires qualification |
| Claude Code | Foreground wait; optional experimental stdio channel | Real ACP action flow and desktop Code request/result/receipt pass; experimental channel remains unqualified |
| Claude Desktop | No inherited Claude Code support claim | Separate transport, registration/executor and UI qualification required |

## Configure the foreground wait

Ambassador's business deadline is 600 seconds and its wait transport budget is
640 seconds. Configure the caller for 660 seconds or longer. Connection/startup
timeouts are different from tool-call timeouts. If a client cannot hold the full
wait, use a shorter explicit `wait_seconds` and retain the same request UUID.

For Codex, add `tool_timeout_sec = 660` to its existing
`[mcp_servers.ambassador]` configuration. For OpenClaw, set the Ambassador
server's `requestTimeoutMs` to `660000`. For Hermes, set the Ambassador
MCP server's `timeout` to `660`. These are provider settings, not Ambassador
CLI flags. Restart/reload the provider's MCP connection after changing them.
For Claude Code, add `"timeout": 660000` to the existing Ambassador server's
MCP configuration. Claude Desktop must be measured separately. Current Claude
Code can move a long call into a provider background task while the original
MCP request remains open; its eventual task notification is different from
resubmitting the action. Do not create a separate scheduled check-in.

The server handles Streamable HTTP for the legacy stateful protocol revisions
and the SDK's current 2026-07-28 stateless path. SSE streams and keepalives reach
the client during an open request. SSE alone cannot start an idle model turn.
MCP Tasks and elicitation are not implemented in this candidate. The owner-email
workflow is available without either capability.

## OpenClaw extension candidate

The package includes `extensions/openclaw/index.mjs` and its
`openclaw.plugin.json`. Build or clean-install the candidate first, then add
that extension directory through OpenClaw's normal local-plugin configuration.
Use the ID `ambassador-conversation-return` and explicitly enable it. Preserve
existing plugins and provider authentication. No Ambassador command installs it.

The extension requests startup activation and captures `sessionKey` from
OpenClaw's tool-hook context. Embedded calls are named `ambassador__message_box`. Codex native calls use `mcp__ambassador__message_box` or
completion telemetry named `ambassador.message_box`; all arguments remain
unchanged to preserve foreground waits. OpenClaw's native relay also rejects
argument rewrites. Completion
telemetry can establish the route when no before hook ran.

OpenClaw activates gateway services and tool hooks separately. Both registrations
share one process-owned bridge. The MCP connection opens on demand and retries
a failed check or receipt once with a fresh connection after an Ambassador restart. The gateway service owns shutdown. Restart the
gateway after enabling the extension or changing its startup manifest.

No model argument chooses the destination. A background check observes the same
request ID through the fixed local Ambassador endpoint. It does not register an
identity or submit another action.

A provider-owned, owner-only route database lives beneath OpenClaw's state
directory at `ambassador-conversation-return/routes.sqlite`. Its instance lock
prevents competing observers. The bridge calls the reviewed `chat.inject`
API. Success means OpenClaw accepted and appended the result. It does not prove
that the desktop rendered it. A terminal result remains unread in Ambassador
until the agent sends its explicit receipt. A session reset can replace the history behind the same logical
session key; the bridge does not claim to pin an old history instance.

A controlled test on OpenClaw 2026.8.2 used the owner's approved current profile
and its Codex backend. Requests from two desktop conversations reached Ambassador,
received exact synthetic results, and returned once to each matching history.
A later pair passed after Ambassador restarted without an OpenClaw restart.
The mixed desktop/RPC test conversations stayed on “Waiting for a response”
even though gateway history contained the completed tool turn and injected
answer. Earlier answers became visible after a gateway reconnect. A fresh
desktop-only retest was blocked by the Mac locking; the cause remains
unconfirmed. Native delivery therefore remains experimental:
preserve the foreground wait and retain final results until an explicit receipt.
Do not label `chat.inject` acceptance as verified desktop display.

A missing destination leaves the result unread. An interrupted injection is
uncertain and is never repeated automatically. Events over the native delivery
bound retain their full result in Ambassador and send retrieval instructions.
Removing the extension restores foreground waits; already submitted work remains
available through the inbox.

## Experimental Claude Code channel

This candidate includes a stdio proxy at `dist/claude-channel.js`. For an
explicit local development test, configure one Ambassador server in the project
`.mcp.json`:

```json
{
  "mcpServers": {
    "ambassador": {
      "command": "node",
      "args": ["/absolute/path/to/installed/ambassador/dist/claude-channel.js"]
    }
  }
}
```

Keep the ordinary Ambassador foreground process running. Start Claude Code
with its documented development-channel opt-in:

```sh
claude --dangerously-load-development-channels server:ambassador
```

Claude's own development confirmation and organization policy still apply.
The proxy forwards the same six tools. New outgoing work returns acceptance
and later events arrive through `notifications/claude/channel` in that
specific stdio conversation. Claude must present actual result data and send
the supplied receipt. Notification acceptance does not consume the result.
Closing the channel loses its original return route, but the operation remains
in Ambassador. This is not a Claude Desktop integration.

## Hermes native return gap

The reviewed plugin API can inject messages, but its tool hooks expose
`session_id` rather than the gateway's `session_key`. Gateway injection requires
that key and explicit opt-in. CLI injection while active interrupts the current
turn, and the public API has no atomic idle-only option. Guessing a route or
checking idle state and then injecting would leave routing/race bugs.

Keep the foreground wait until Hermes provides both a trusted origin route and
a delivery operation with defined busy-session behavior. A future extension can
use the existing durable operation and receipt model without changing the API
or adding another incoming delivery mode.

## Sources and release gates

Reviewed on 2026-09-05 against installed provider source and these primary docs:

- [MCP July revision](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [SDK protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [OpenClaw MCP configuration](https://docs.openclaw.ai/tools/mcp)
- [OpenClaw hooks](https://docs.openclaw.ai/plugins/hooks)
- [Hermes plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- [Claude Code channels](https://code.claude.com/docs/en/channels-reference)
- [Claude Code MCP timeouts and background calls](https://code.claude.com/docs/en/mcp)
- [OpenClaw hook session policy](https://docs.openclaw.ai/gateway/configuration-reference#hook-session-and-agent-policy)

Qualify initial acceptance, the full wait, permission-only progress, owner
questions, exact final data, reconnect, duplicate events, closed conversations,
provider restart and ambiguous injection. Use synthetic test data and record
which real app actually displayed it. Existing API recovery gaps remain
documented limitations. The owner approved detailed body retention for this
development release, with mandatory credential redaction, under ADR 0059.
