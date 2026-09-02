# Get started with Claude Code

Status: implementation candidate; source-reviewed against Claude Code 2.1.257
and 2.1.258 plus `@agentclientprotocol/claude-agent-acp` 0.73.0, with the exact
ACP initialization contract probed and real-agent qualification still required
before publication

Ambassador enables Claude Code only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `claude-code` / `2.1.257` or `2.1.258` |
| Delivery modes | direct and webhook |
| Direct command | `claude-agent-acp` |
| ACP adapter | `@agentclientprotocol/claude-agent-acp` / `0.73.0` |
| Accepted ACP `agentInfo` | `@agentclientprotocol/claude-agent-acp` / `0.73.0` |
| Ambassador MCP in the direct session | ACP HTTP MCP injection |

Ambassador uses the existing
[`agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
adapter. It does not contain a Claude adapter. The reviewed release is
[`v0.73.0`](https://github.com/agentclientprotocol/claude-agent-acp/tree/v0.73.0).
Its
[`package.json`](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.73.0/package.json)
defines the `claude-agent-acp` command, pins `@agentclientprotocol/sdk` 1.4.0,
and pins `@anthropic-ai/claude-agent-sdk` 0.3.257. Its
[`acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.73.0/src/acp-agent.ts)
returns the adapter identity and maps HTTP MCP session configuration into the
Claude Agent SDK.

The selected SDK contains Claude Code 2.1.257. The separately reviewed current
Claude Code package is 2.1.258. Both exact versions use the `claude-code` MCP
identity and map to the same fixed profile. Other Claude Code or adapter
versions fail closed until the registry is reviewed and updated.

## Setup

1. Install `@agentclientprotocol/claude-agent-acp` 0.73.0 through its normal
   package installation process. Ambassador never installs or updates it.
2. Authenticate Claude through normal Claude Code setup, or set one approved
   adapter authentication variable outside chat: `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`.
3. Generate a 48-character lowercase hexadecimal local token and export it,
   for example as `AMBASSADOR_LOCAL_TOKEN`.
4. Start Ambassador from the directory the direct agent may access:

   ```sh
   ambassador start --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

5. Configure Claude Code MCP to call the printed loopback endpoint with
   `Authorization: Bearer <local-token>`.
6. Ask Claude Code to call `register_agent`. Ambassador asks direct versus
   webhook and advertises direct as the default.
7. For direct mode, make the follow-up with `delivery.mode` set to `direct`.
   Ambassador starts `claude-agent-acp` and injects its authenticated HTTP MCP
   server into the new ACP session.
8. For webhook mode, configure an authenticated receiver for the canonical
   Ambassador message and supply only its URL and webhook-secret environment
   variable name.
9. Complete email verification through MCP.

Ambassador does not pass `CLAUDE_CODE_EXECUTABLE` or another executable
override. It never receives Claude account credentials, the central token, or
the DPoP private key. Never put the local token or a provider credential in
chat or registration arguments.
