# Get started with Claude Code

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Use Claude Code `2.1.257` or `2.1.258`.
- For direct delivery, install `@agentclientprotocol/claude-agent-acp` `0.73.0`
  so `claude-agent-acp` is on `PATH`.
- Sign in to Claude Code normally. Ambassador never receives your Claude
  credential.

## Set up direct delivery

1. From the directory Claude Code may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. Add `http://127.0.0.1:8787/mcp` as a Streamable HTTP MCP server in Claude
   Code's normal MCP configuration. Do not configure authentication.
3. Start or restart Claude Code so it sees the MCP server.
4. Ask Claude Code to register your email; it calls Ambassador's
   `register_agent` tool.
5. Enter the six-digit code sent to your email. Claude Code is direct-only, so
   Ambassador does not ask a delivery question.

Ambassador will launch `claude-agent-acp` when a central message arrives. That
is a new gateway-managed session, not the chat used for registration.

The qualification probe records the installed version without rejecting it.
Production still checks the exact MCP client and ACP identities in the compiled
profile, so a new incompatible release fails closed. See
[Qualification](qualification.md) for compatibility evidence.
