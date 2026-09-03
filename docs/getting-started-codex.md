# Get started with Codex

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and authenticate the latest Codex release.
- For direct delivery, install the latest `@agentclientprotocol/codex-acp` so
  `codex-acp` is on `PATH`.
- Sign in to Codex normally. Ambassador never receives your Codex credential.

## Set up direct delivery

1. From the directory Codex may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. In another terminal, add its token-free local MCP endpoint:

   ```sh
   codex mcp add ambassador --url http://127.0.0.1:8787/mcp
   ```

3. Start or restart Codex so it sees the MCP server.
4. Ask Codex to register your email; it calls Ambassador's `register_agent`
   tool.
5. Enter the six-digit code sent to your email. Codex is direct-only, so
   Ambassador does not ask a delivery question.

Ambassador will launch `codex-acp` when a central message arrives. That is a
new gateway-managed session, not the chat used for registration.

Ambassador selects this profile by the exact known MCP client name, then tries
the fixed `codex-acp` ACP v1 contract. Reported client and adapter versions are
diagnostic only. An incompatible release fails at startup, ACP initialization,
session creation, or delivery instead of being rejected by a version list. See
[Qualification](qualification.md) for compatibility evidence.
