# Claude Chat and Cowork local connection

This source candidate includes a local client for Claude Desktop's Chat and
Cowork surfaces. It is separate from the Claude Code executor and the
experimental Claude Code channel. No public connector package is released.

First register or log in through Embassys and finish its agent setup. Keep its
server running. The saved executor handles incoming requests; Claude Chat can
make requests and receive results in its current conversation through the local
client. It cannot act as the app's incoming ACP executor.

## Manual development setup

1. In Claude Desktop, open Settings > Developer > Edit config to locate its
   configuration file. Quit Claude completely before editing: the application
   can write its in-memory settings back on exit.
2. Preserve every other configuration entry. Add `mcpServers.embassys` using
   the bundled Node executable and `gateway/dist/desktop-stdio.js` from the same
   local Embassys build. Set `EMBASSYS_MCP_PORT` to the port shown in Embassys.
3. Reopen Claude. Its local MCP settings should list Embassys. Use Chat or
   Cowork and ask naturally, for example: "Can you get Alex's phone number from
   their agent?" Supply the person's email when needed.

Fresh Cowork tasks sometimes miss an enabled local connector. If that happens,
say "Use the Embassys connector". This is a known client-discovery limitation;
renaming the connector helped one trial but did not make discovery reliable.

For a Mac app placed at `/Applications/Embassys.app`, the entry is:

```json
{
  "mcpServers": {
    "embassys": {
      "command": "/Applications/Embassys.app/Contents/Resources/gateway/runtime/node",
      "args": [
        "/Applications/Embassys.app/Contents/Resources/gateway/dist/desktop-stdio.js"
      ],
      "env": { "EMBASSYS_MCP_PORT": "8787" }
    }
  }
}
```

Replace the app location if your development build is elsewhere. On Windows,
the corresponding files are `resources/gateway/runtime/node.exe` and
`resources/gateway/dist/desktop-stdio.js` beneath the local package. Windows
Claude behavior still needs native qualification. The relay's portable source
does not establish client availability or qualification on Linux.

Do not put this URL in Claude's web connector form: that form expects a remote
HTTPS service. Do not copy credentials or select another incoming agent through
tool arguments. If the server was stopped when Claude launched, start Embassys
and restart the local connector using Claude's normal controls.

## Waiting and stopping

The gateway defaults to ten-minute waits. The owner explicitly retained this
behavior after tests found earlier host deadlines in standalone Chat and Cowork.
Omit `wait_seconds`, or explicitly supply 600. Use a shorter wait only when the
user asks for one. The relay forwards exact arguments and progress when requested.
Its initialization and tool help explain before dispatch that an early host
timeout leaves the same request available for a later user-driven check. A
connection that has already closed cannot receive a late tool reply.
Stopping the conversation cancels its observation; the saved operation remains
available through a later check. Closing Claude also closes that client's local
MCP session. Neither event cancels or replays an already submitted remote action.

There is no background conversation injection or scheduled retry. At a pending
timeout, ask Claude to check that same request again. A host timeout means its
observation ended; it does not establish a server crash or a failed action.
Results remain available
until the requesting model sends an explicit receipt. Claude's own tool approval
prompts still apply.

To remove this manual connection, quit Claude, remove only the Embassys entry
you added, and reopen Claude. Keep other connectors and preferences intact.

See [ADR 0074](adr/0074-desktop-stdio-client.md) and the
[September 8 qualification](client-completion-2026-09-08.md). Anthropic documents
the distinction between [local desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
and its [local MCP setup controls](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
