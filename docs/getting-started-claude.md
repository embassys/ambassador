# Get started with Claude Code

Release target: `@embassys/ambassador@0.2.6`. The profile is source-reviewed
against Claude Code 2.1.257 and 2.1.258 plus
`@agentclientprotocol/claude-agent-acp` 0.73.0, and its exact ACP initialization
contract passed. Real-agent direct and webhook qualification remain open under
the one-release qualification exception in ADR 0015.

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

1. Install Node.js `>=24.19.0 <25` and
   `@agentclientprotocol/claude-agent-acp` 0.73.0 through its normal package
   installation process. Ambassador never installs or updates the adapter.
2. Authenticate Claude through normal Claude Code setup, or set one approved
   adapter authentication variable outside chat: `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`.
3. Generate the local MCP token without putting its value in chat or a command
   argument:

   ```sh
   export AMBASSADOR_LOCAL_TOKEN="$(
     node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
   )"
   ```

4. If you may choose webhook delivery, create its secret in the same shell
   before starting Ambassador:

   ```sh
   export AMBASSADOR_WEBHOOK_SECRET="$(
     node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
   )"
   ```

5. From the directory the direct agent may access, start the exact release and
   keep it running in the foreground:

   ```sh
   npx --yes @embassys/ambassador@0.2.6 start \
     --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

6. Configure Claude Code's MCP client to use the loopback endpoint printed by
   Ambassador, with a bearer token read from `AMBASSADOR_LOCAL_TOKEN`. Use the
   provider's normal MCP configuration mechanism; do not copy the token value
   into chat.
7. Ask Claude Code to register with your email and optional display name. The
   first `register_agent` call contains `email` and, if wanted, `display_name`.
   Ambassador recognizes the Claude Code profile and asks direct versus
   webhook, with direct as the default.
8. For direct mode, choose direct. The follow-up repeats the same `email` and
   optional `display_name` and adds `delivery: {"mode":"direct"}`. Ambassador
   starts `claude-agent-acp` and injects its authenticated HTTP MCP server into
   the new ACP session.
9. For webhook mode, choose webhook and provide the HTTPS receiver URL plus
   the environment-variable name `AMBASSADOR_WEBHOOK_SECRET`. The follow-up
   repeats the registration fields and adds `delivery.mode`, `delivery.url`,
   and `delivery.secret_env`; it never sends the secret value.
10. Enter the email verification code when Claude Code asks for it. Claude
    Code calls `verify_email` with that `email` and six-digit `code`; the
    central token and DPoP key stay inside Ambassador.

Ambassador does not pass `CLAUDE_CODE_EXECUTABLE` or another executable
override. It never receives Claude account credentials, the central token, or
the DPoP private key. Never put the local token or a provider credential in
chat or registration arguments.
