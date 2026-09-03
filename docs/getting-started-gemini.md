# Get started with Gemini CLI

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and sign in to Gemini CLI `0.58.0`.
- Gemini supplies native ACP through `gemini --acp`; no adapter is needed.
- Ambassador never receives your Gemini or Google credential.

## Set up direct delivery

1. From the directory Gemini CLI may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@0.2.7 start
   ```

2. Add `http://127.0.0.1:8787/mcp` as a Streamable HTTP MCP server in Gemini
   CLI's normal MCP configuration. Do not configure authentication.
3. Start or restart Gemini CLI so it sees the MCP server.
4. Ask Gemini CLI to register your email; it calls Ambassador's
   `register_agent` tool.
5. Enter the six-digit code sent to your email. Gemini CLI is direct-only, so
   Ambassador does not ask a delivery question.

Ambassador will launch `gemini --acp` when a central message arrives. That is
a new gateway-managed session, not the chat used for registration.

Only the exact version above is enabled. Other versions fail closed until
their capability profile is reviewed. See [Qualification](qualification.md)
for compatibility evidence.
