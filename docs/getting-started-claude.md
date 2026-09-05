# Get started with Claude Code

## 1. Start Ambassador

- Install Node.js `>=24.19.0` and Claude Code.
- Configure Claude Code authentication normally. Ambassador leaves account,
  API, cloud-provider, and organization policy decisions to the official CLI.
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

Later, you can ask:

- **Check my Embassys inbox.** Claude Code lists action requests waiting for an
  answer and unread results returned by other identities.
- When another identity requests an Embassys permission, you decide from the
  email sent to your registered address. Claude Code does not approve it.

## Incoming messages

- Ambassador includes the public Claude ACP adapter; you do not install it.
- The adapter uses Claude Code's normal authentication and configuration.
- Messages from the same remote identity reuse a persistent provider session
  within your enrollment and working directory. The registration chat remains separate.
- Ambassador passes no extra MCP servers and does not disable built-in tools,
  choose safe mode, or request permission bypass.
- If Claude asks to use a tool, Ambassador emails you at your registered address and keeps
  the request pending until their decision arrives through Embassys. An
  approval is passed to Claude as **allow once** when available.
- Anthropic remains responsible for authentication, policy, and
  billing behavior.

If startup or ACP initialization fails, Ambassador leaves MCP available and
prints a bounded reason while incoming delivery is paused. Confirm Claude Code
is signed in, update Ambassador, and restart it. For a clean local registration test, see
[Reset local test state](development-reset.md).

## Inspect sessions

- Keep Ambassador running.
- Run `npx --yes @embassys/ambassador@latest sessions list`.
- Run `npx --yes @embassys/ambassador@latest sessions show <session-id>`.
- Add `--verbose` to `show` for bounded tool events.
- Stop Ambassador before using `sessions delete <session-id>` to delete
  provider history or `sessions forget <session-id>` to remove only
  Ambassador's record.

The command follows the current
[Claude Code MCP instructions](https://code.claude.com/docs/en/mcp).

For requesting an action, waiting for email approval, answering later, and
retrieving results, see [Request and answer an action](action-workflow.md).
Provider compaction manages context; sessions with no unfinished work become
eligible for cleanup after 30 idle days. `sessions show` labels a truncated
recent preview when provider history is large.
