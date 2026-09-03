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

- **Which Embassys permission requests are waiting for my approval?** Then tell
  Codex which one to grant or deny.
- **Which Embassys actions are waiting for my answer?** Then give Codex the
  requested value so it can submit the result.

## Incoming messages

Ambassador includes the approved Codex ACP adapter and launches it when a
central message arrives. You do not install `codex-acp` separately. The
incoming message runs in a new Ambassador-managed session, not the registration
chat.

If startup or ACP initialization fails, Ambassador prints a bounded reason.
Confirm Codex is signed in, update Ambassador, and restart it. For a clean local
registration test, see [Reset local test state](development-reset.md).

Codex MCP setup follows the current
[official MCP instructions](https://developers.openai.com/codex/mcp).
