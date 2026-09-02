# Get started with OpenClaw

Status: implementation candidate; source-reviewed against OpenClaw 2026.8.1,
with real-agent qualification still required before publication

Ambassador enables OpenClaw only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `openclaw-bundle-mcp` / `0.0.0` |
| Delivery modes | direct and webhook |
| Direct command | `openclaw acp` |
| Accepted ACP `agentInfo` | `openclaw-acp` / `2026.8.1` |
| Ambassador MCP in the direct session | provider configuration required |

The contract was reviewed at OpenClaw revision
`a68a4e39684168cf83201cf48261be23174bad3d`. The source defines the MCP alias in
[`agent-bundle-mcp-runtime.ts`](https://github.com/openclaw/openclaw/blob/a68a4e39684168cf83201cf48261be23174bad3d/src/agents/agent-bundle-mcp-runtime.ts),
the ACP identity in
[`acp/types.ts`](https://github.com/openclaw/openclaw/blob/a68a4e39684168cf83201cf48261be23174bad3d/src/acp/types.ts),
and the command in
[`acp-cli.ts`](https://github.com/openclaw/openclaw/blob/a68a4e39684168cf83201cf48261be23174bad3d/src/cli/acp-cli.ts).
Later versions fail closed until the registry is reviewed and updated.

## Setup

1. Install and authenticate the supported OpenClaw version using its normal
   provider setup. Ambassador never installs or updates OpenClaw.
2. Generate a 48-character lowercase hexadecimal local token and export it,
   for example as `AMBASSADOR_LOCAL_TOKEN`.
3. Start Ambassador from the directory the direct agent may access:

   ```sh
   ambassador start --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

4. Configure OpenClaw's MCP client to call the printed loopback endpoint with
   `Authorization: Bearer <local-token>`. OpenClaw's ACP interface does not
   accept session MCP injection, so this normal provider configuration is
   required for direct delivery.
5. Ask OpenClaw to call `register_agent`. The first call asks direct versus
   webhook and advertises direct as the default.
6. For direct mode, make the follow-up with `delivery.mode` set to `direct`.
   Ambassador records the canonical startup directory and rejects a later
   start from a different directory.
7. For webhook mode, configure an authenticated receiver that accepts the
   canonical Ambassador message. Supply only its URL and the name of the
   environment variable containing its secret. Receiver-side conversion to an
   OpenClaw-native hook belongs outside Ambassador.
8. Complete email verification through MCP.

OpenClaw receives neither the central token nor the DPoP private key. Never put
the local token or webhook secret in chat or registration arguments.

For the opt-in real-agent suite, configure this same provider-side MCP entry at
`http://127.0.0.1:8787/mcp` using `AMBASSADOR_QUALIFICATION_LOCAL_TOKEN`; the
runner verifies that OpenClaw calls it with the exact reviewed `clientInfo`.
