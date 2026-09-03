# Get started with Codex

Release target: `@embassys/ambassador@0.2.6`. The profile is source-reviewed
against Codex 0.149.0 and 0.152.1 plus
`@agentclientprotocol/codex-acp` 1.8.0. The exact ACP initialization contract
and direct live-central flow passed. Webhook qualification and a repeat of the
direct case on supported Node remain open under the one-release qualification
exception in ADR 0015.

Ambassador enables Codex only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `codex-mcp-client` / `0.149.0` or `0.152.1` |
| Delivery modes | direct and webhook |
| Direct command | `codex-acp` |
| ACP adapter | `@agentclientprotocol/codex-acp` / `1.8.0` |
| Accepted ACP `agentInfo` | `@agentclientprotocol/codex-acp` / `1.8.0` |
| Ambassador MCP in the direct session | ACP HTTP MCP injection |

Ambassador uses the existing
[`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
adapter. It does not contain a Codex adapter. The reviewed adapter revision is
[`87997e2627e8fa246a49de533c612f6196c4004e`](https://github.com/agentclientprotocol/codex-acp/tree/87997e2627e8fa246a49de533c612f6196c4004e).
Its
[`package.json`](https://github.com/agentclientprotocol/codex-acp/blob/87997e2627e8fa246a49de533c612f6196c4004e/package.json)
defines the `codex-acp` command and exact adapter version. Its
[`CodexAcpServer.ts`](https://github.com/agentclientprotocol/codex-acp/blob/87997e2627e8fa246a49de533c612f6196c4004e/src/CodexAcpServer.ts)
returns the ACP identity, and
[`CodexAcpClient.ts`](https://github.com/agentclientprotocol/codex-acp/blob/87997e2627e8fa246a49de533c612f6196c4004e/src/CodexAcpClient.ts)
maps session MCP configuration into Codex App Server.

The Codex MCP alias comes from
[`rmcp_client.rs`](https://github.com/openai/codex/blob/dcfcb570b2cd0a2500b1d47a7b04a7cb1b0a0bd2/codex-rs/codex-mcp/src/rmcp_client.rs).
OpenAI documents App Server as the protocol for embedding Codex in another
product in the
[`Codex App Server` documentation](https://learn.chatgpt.com/docs/app-server).
Later Codex or adapter versions fail closed until the registry is reviewed and
updated.

## Setup

1. Install Node.js `>=24.19.0 <25` and
   `@agentclientprotocol/codex-acp` 1.8.0 through its normal package
   installation process. Ambassador never installs or updates the adapter.
2. Authenticate Codex through the adapter's normal ChatGPT login, or set
   `CODEX_API_KEY` or `OPENAI_API_KEY` outside chat. The adapter owns provider
   authentication.
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

6. In a shell where `AMBASSADOR_LOCAL_TOKEN` is available, configure Codex to
   use the endpoint printed by Ambassador:

   ```sh
   codex mcp add ambassador \
     --url http://127.0.0.1:8787/mcp \
     --bearer-token-env-var AMBASSADOR_LOCAL_TOKEN
   ```

7. Ask Codex to register with your email and optional display name. The first
   `register_agent` call contains `email` and, if wanted, `display_name`.
   Ambassador recognizes the Codex MCP profile and asks direct versus webhook,
   with direct as the default.
8. For direct mode, choose direct. The follow-up repeats the same `email` and
   optional `display_name` and adds `delivery: {"mode":"direct"}`. Ambassador
   starts `codex-acp` and injects its authenticated HTTP MCP server into the new
   ACP session.
9. For webhook mode, choose webhook and provide the HTTPS receiver URL plus
   the environment-variable name `AMBASSADOR_WEBHOOK_SECRET`. The follow-up
   repeats the registration fields and adds `delivery.mode`, `delivery.url`,
   and `delivery.secret_env`; it never sends the secret value.
10. Enter the email verification code when Codex asks for it. Codex calls
    `verify_email` with that `email` and six-digit `code`; the central token and
    DPoP key stay inside Ambassador.

Ambassador does not pass `CODEX_PATH`, `CODEX_CONFIG`, or another executable or
session override. It never receives Codex account credentials, the central
token, or the DPoP private key. Never put the local token or a provider API key
in chat or registration arguments.
