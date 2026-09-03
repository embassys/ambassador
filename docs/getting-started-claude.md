# Get started with Claude Code

## 1. Start Ambassador

- Install Node.js `>=24.19.0` and Claude Code.
- Sign in to Claude Code normally. Ambassador never receives your Claude
  credential.
- In the directory Claude Code may access, run:

  ```sh
  npx --yes @embassys/ambassador@latest start
  ```

- Keep that terminal open.

## 2. Add Ambassador to Claude Code

In another terminal, run:

```sh
claude mcp add --transport http --scope user ambassador http://127.0.0.1:8787/mcp
```

- Check it with `claude mcp get ambassador` or `claude mcp list`.
- Start or restart Claude Code and use `/mcp` to confirm the connection.
- In the Claude Desktop app, use the **Code** tab. Do not use **Add custom
  connector** in ordinary Claude chat: that screen requires a public HTTPS URL
  and rejects Ambassador's local `http://127.0.0.1` endpoint.

## 3. Register

- Say: **Register me with Embassys using me@example.com.**
- Give Claude Code the six-digit code sent to that address.
- Claude Code uses direct delivery automatically.

To review unanswered requests later, say: **Which Embassys permission requests
are waiting for my response?** After Claude lists them, tell it which request
to grant or deny.

## Incoming messages

Ambassador includes the approved Claude Agent ACP adapter and launches it when
a central message arrives. You do not install `claude-agent-acp` separately.
The incoming message runs in a new Ambassador-managed session, not the
registration chat.

If startup or ACP initialization fails, Ambassador prints a bounded reason.
Confirm Claude Code is signed in, update Ambassador, and restart it. For a
clean local registration test, see
[Reset local test state](development-reset.md).

The command follows the current
[Claude Code MCP instructions](https://code.claude.com/docs/en/mcp).
