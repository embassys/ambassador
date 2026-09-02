# Get started with Codex

Status: implementation candidate; source-reviewed against Codex 0.149.0 and
0.152.1 plus `@agentclientprotocol/codex-acp` 1.8.0, with the exact ACP
initialization contract probed and the direct real-agent case passed. Webhook
qualification is still required before publication. The direct pass included
the live central REST service, a controlled peer, polling, ACP delivery, an
Ambassador MCP call, and central acknowledgement.

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

1. Install `@agentclientprotocol/codex-acp` 1.8.0 through its normal package
   installation process. Ambassador never installs or updates it.
2. Authenticate Codex through the adapter's normal ChatGPT login or set
   `CODEX_API_KEY` or `OPENAI_API_KEY` outside chat. The adapter owns provider
   authentication.
3. Generate a 48-character lowercase hexadecimal local token and export it,
   for example as `AMBASSADOR_LOCAL_TOKEN`.
4. Start Ambassador from the directory the direct agent may access:

   ```sh
   ambassador start --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

5. Configure Codex MCP to call the printed loopback endpoint with
   `Authorization: Bearer <local-token>`.
6. Ask Codex to call `register_agent`. Ambassador asks direct versus webhook
   and advertises direct as the default.
7. For direct mode, make the follow-up with `delivery.mode` set to `direct`.
   Ambassador starts `codex-acp` and injects its authenticated HTTP MCP server
   into the new ACP session.
8. For webhook mode, configure an authenticated receiver for the canonical
   Ambassador message and supply only its URL and webhook-secret environment
   variable name.
9. Complete email verification through MCP.

Ambassador does not pass `CODEX_PATH`, `CODEX_CONFIG`, or another executable or
session override. It never receives Codex account credentials, the central
token, or the DPoP private key. Never put the local token or a provider API key
in chat or registration arguments.
