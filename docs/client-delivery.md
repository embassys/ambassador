# Client delivery and qualification

This describes the ADR 0061 development release, version 0.2.19. Configuration does not prove
that a client displayed a result. Evidence belongs in [qualification](qualification.md).

| Client | Implemented path | Current qualification |
| --- | --- | --- |
| OpenClaw | Foreground wait; experimental hook bridge to the captured logical session key | Real ACP, two-conversation history routing and foreground deferral pass. Idle return appears, but the desktop shows a duplicate badge despite one saved answer |
| Hermes CLI/gateway | Foreground wait and durable inbox/check | Real ACP and current real webhook action/result/receipt pass; native return deferred pending a trusted gateway routing key and idle-only injection |
| Codex | Foreground wait and later check | Real ACP and desktop registration/result/receipt pass; a fresh September 8 desktop task recognized Embassys immediately through the configured integration |
| Claude Code | Foreground wait; optional experimental stdio channel | Real ACP, ten-minute desktop wait and experimental channel tests pass; September 8 combined native app signup → deployed central → real OpenClaw owner input → visible Claude result and receipt also passes |
| Claude Desktop Chat | Local stdio client; app owns enrollment and incoming executor | Natural request, real OpenClaw result and receipt pass. A 150-second pending reply displays correctly; 240-second host ceiling. Shared connector recommends 45 seconds to cover Cowork too |
| Claude Desktop Cowork | Local stdio client; app owns enrollment and incoming executor | Natural phone request, real OpenClaw result and receipt pass. Guided 45-second pending reply displays correctly and ends without retry. Fresh Embassys discovery is intermittent; a desktop bridge can time out at 60 seconds |

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
MCP configuration. Standalone Claude Desktop uses the separately measured
[local client](claude-desktop-local-client.md) with explicit 45-second waits.
Current Claude
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
request ID through the enabled local `mcp.servers.ambassador` connection in
OpenClaw's configuration. Only literal loopback Streamable HTTP URLs are accepted;
missing or incompatible settings disable native return without falling back to
port 8787. Restart OpenClaw after changing that connection. It does not register an
identity or submit another action.

The optional prompt hook adds fixed Embassys discovery and continuation guidance
before the model chooses a tool. It does not read the prompt/history or add
visible conversation messages. OpenClaw requires the extension's
`hooks.allowConversationAccess` setting for this hook and must not have
`hooks.allowPromptInjection` disabled. These settings are owner choices and are
not changed by the desktop connection helper. Without the hook, MCP initialization
and the existing tool descriptions still provide the workflow guidance.
If the host forbids verification codes in chat, the guidance directs the owner
to Account > Set up this device in the Embassys app for the same installation.

A provider-owned, owner-only route database lives beneath OpenClaw's state
directory at `ambassador-conversation-return/<endpoint-sha256>/routes.sqlite`. Its instance lock
prevents competing observers. The bridge calls the reviewed `chat.inject`
API. Success means OpenClaw accepted and appended the result. It does not prove
that the desktop rendered it. A terminal result remains unread in Ambassador
until the agent sends its explicit receipt. A session reset can replace the history behind the same logical
session key; the bridge does not claim to pin an old history instance.

Endpoint namespaces keep independent instances' routes separate. The old unscoped
route journal is left untouched and is not replayed; existing results remain
available through foreground checks and the inbox. No provider configuration or
credential is copied between instances. See [ADR 0070](adr/0070-instance-scoped-native-observers.md).

Desktop direct delivery also checks the selected executor's configured Ambassador
binding before dispatch. A mismatch, disabled connection or unsupported project
override pauses delivery with the message still pending. The app shows a notice
to repair the connection and restart. This does not pin cached provider connections
or create independent provider profiles. See [ADR 0071](adr/0071-desktop-executor-checks-and-mac-vibrancy.md).

Controlled tests on OpenClaw 2026.8.2 used the owner's approved current profile
and Codex backend. Requests from two desktop conversations received exact
synthetic results and returned once to each matching history, including after
Ambassador restarted. A fresh desktop-only test reproduced a stale working view
when foreground and native delivery overlapped.

The observer now defers to an active foreground turn and rereads the operation
after it ends, so a foreground receipt can prevent another native answer. A
fresh desktop test of that correction finished normally, displayed the exact
number and retained one answer in history. A separate short-wait test ended its
foreground turn, then displayed the delayed native result without user follow-up.
The desktop showed a “×2” duplicate badge and obscured the earlier waiting text,
although gateway history contained one native answer and the original waiting
reply. Ordinary navigation did not clear that display discrepancy. The result
remained unread in Ambassador, with its receipt available.

Native return remains experimental because of this provider UI behavior. The
activity check and injection are also separate calls; there is no atomic display
guarantee. Preserve foreground waits and retain final results until an explicit
receipt. These tests qualify observed paths, not general exactly-once desktop
presentation. Screenshots and history evidence are in [qualification](qualification.md).

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
