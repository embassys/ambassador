# Get started with Claude Code

## Before you start

- Install Node.js `>=24.19.0`.
- Install Claude Code.
- For direct delivery, install `@agentclientprotocol/claude-agent-acp` so
  `claude-agent-acp` is on `PATH`.
- Sign in to Claude Code normally. Ambassador never receives your Claude
  credential.

## Set up direct delivery

1. From the directory Claude Code may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. In another terminal, add its token-free local MCP endpoint for every Claude
   Code project:

   ```sh
   claude mcp add --transport http --scope user ambassador http://127.0.0.1:8787/mcp
   ```

   Do not use Claude's remote custom-connector screen. It requires a public
   HTTPS server and cannot connect to Ambassador's loopback endpoint.
3. Start or restart Claude Code. In the Claude Desktop app, use the Code tab,
   not the regular chat tab.
4. Ask Claude Code to register your email; it calls Ambassador's
   `register_agent` tool.
5. Enter the six-digit code sent to your email. Claude Code is direct-only, so
   Ambassador does not ask a delivery question.

Ambassador will launch `claude-agent-acp` when a central message arrives. That
is a new gateway-managed session, not the chat used for registration.

Ambassador selects this profile by the exact known MCP client name, then tries
the fixed `claude-agent-acp` ACP v1 contract. Reported client and adapter
versions are diagnostic only. An incompatible release fails at startup, ACP
initialization, session creation, or delivery instead of being rejected by a
version list. See
[Qualification](qualification.md) for compatibility evidence.

For local reruns, see [Reset local test state](development-reset.md).
