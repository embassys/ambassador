# Get started with Codex

## 1. Start Ambassador

- Install Node.js `>=24.19.0` and Codex.
- Sign in to Codex normally. Ambassador never receives your Codex credential.
- In the directory Codex may access, run:

  ```sh
  npx --yes @embassys/ambassador@latest start
  ```

- Keep that terminal open. Ambassador prints its MCP endpoint and the setup
  commands below.

## 2. Add Ambassador to Codex

Choose either method.

### Command

Run this in another terminal:

```sh
codex mcp add ambassador --url http://127.0.0.1:8787/mcp
```

Check it with `codex mcp list`. Inside Codex, `/mcp` shows active servers.

Set the tool timeout in the existing entry in `~/.codex/config.toml`, or in a
trusted project's `.codex/config.toml`, so the ten-minute wait can finish:

```toml
[mcp_servers.ambassador]
url = "http://127.0.0.1:8787/mcp"
tool_timeout_sec = 660
```

For a project that requires Embassys tools on its first turn, also set
`required = true` in that entry. Codex then waits for Ambassador's startup and
reports a connection failure instead of starting with the server unavailable.
Keep Ambassador running before opening the chat. A required global entry also
affects unrelated Codex projects, so prefer project scope for this setting.

### Codex desktop app or IDE

- Open **Settings → MCP servers → Add server**.
- Name: `ambassador`
- Transport: **Streamable HTTP**
- URL: `http://127.0.0.1:8787/mcp`
- Authentication: none
- Save, then restart Codex or the extension.

The desktop app, CLI, and IDE share Codex MCP configuration. ChatGPT web does
not connect to this loopback server.

## 3. Register

- Start a fresh Codex chat.
- Say: **Register me with Embassys using me@example.com.**
- Give Codex the six-digit code sent to that address.
- Codex uses direct delivery automatically.

Later, you can ask:

- **Check my Embassys inbox.** Codex lists action requests waiting for an answer
  and unread results returned by other identities.
- When another identity requests an Embassys permission, you decide from the
  email sent to your registered address. Codex does not approve it.

## Incoming messages

Ambassador includes the approved Codex ACP adapter and launches it when a
central message arrives. You do not install `codex-acp` separately. Ambassador reuses a persistent session for the same remote identity within
your enrollment and working directory. The registration chat remains separate. Ambassador loads tools from normal Codex configuration, passes no extra
MCP servers, and does not disable built-in tools, choose safe mode, or request
permission bypass. If Codex asks to use a tool, Ambassador emails you at your registered address and keeps the request pending until their decision arrives through
Embassys. Ambassador presents the provider's exact choices and returns your selected option unchanged.

## Inspect sessions

- Keep Ambassador running.
- Run `npx --yes @embassys/ambassador@latest sessions list`.
- Run `npx --yes @embassys/ambassador@latest sessions show <session-id>`.
- Add `--verbose` to `show` for bounded tool events.
- Stop Ambassador before using `sessions delete <session-id>` to delete
  provider history or `sessions forget <session-id>` to remove only
  Ambassador's record.

If startup or ACP initialization fails, Ambassador prints a bounded reason.
Confirm Codex is signed in, update Ambassador, and restart it. For a clean local
registration test, see [Reset local test state](development-reset.md).

Codex MCP setup follows the current
[official MCP instructions](https://developers.openai.com/codex/mcp).

For requesting an action, waiting for email approval, answering later, and
retrieving results, see [Request and answer an action](action-workflow.md).
Provider compaction manages context; sessions with no unfinished work become
eligible for cleanup after 30 idle days. `sessions show` labels a truncated
recent preview when provider history is large.

For the unpublished workflow candidate, configure the provider tool timeout
above 640 seconds or use an explicit shorter wait. Requests and later checks
use message_box, and results remain until receipt. See
[Client delivery and qualification](client-delivery.md).
