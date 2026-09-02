# Get started with Gemini CLI

Status: implementation candidate; source-reviewed against Gemini CLI 0.58.0,
with the exact ACP initialization contract probed and real-agent qualification
still required before publication

Ambassador enables Gemini CLI only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `gemini-cli-mcp-client` / `0.58.0` |
| Delivery modes | direct and webhook |
| Direct command | `gemini --acp` |
| Accepted ACP `agentInfo` | `gemini-cli` / `0.58.0` |
| Ambassador MCP in the direct session | ACP HTTP MCP injection |

Gemini CLI supplies native ACP, so Ambassador does not select or contain an
adapter. The reviewed release is
[`v0.58.0`](https://github.com/google-gemini/gemini-cli/tree/v0.58.0). Its
[`ACP mode documentation`](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/docs/cli/acp-mode.md)
defines `gemini --acp`. Its
[`acpRpcDispatcher.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpRpcDispatcher.ts)
returns the `gemini-cli` ACP identity, and
[`acpSessionManager.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpSessionManager.ts)
maps session MCP configuration into Gemini CLI. The MCP client identity comes
from
[`mcp-client.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/core/src/tools/mcp-client.ts).
Other versions fail closed until the registry is reviewed and updated.

## Setup

1. Install and authenticate Gemini CLI 0.58.0 using its normal setup.
   Ambassador never installs or updates it.
2. For noninteractive provider authentication, set the appropriate approved
   Gemini or Vertex variables outside chat. The profile accepts
   `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
   `GOOGLE_CLOUD_LOCATION`, and `GOOGLE_GENAI_USE_VERTEXAI`.
3. Generate a 48-character lowercase hexadecimal local token and export it,
   for example as `AMBASSADOR_LOCAL_TOKEN`.
4. Start Ambassador from the directory the direct agent may access:

   ```sh
   ambassador start --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

5. Configure Gemini CLI MCP to call the printed loopback endpoint with
   `Authorization: Bearer <local-token>`.
6. Ask Gemini CLI to call `register_agent`. Ambassador asks direct versus
   webhook and advertises direct as the default.
7. For direct mode, make the follow-up with `delivery.mode` set to `direct`.
   Ambassador starts `gemini --acp` and injects its authenticated HTTP MCP
   server into the new ACP session.
8. For webhook mode, configure an authenticated receiver for the canonical
   Ambassador message and supply only its URL and webhook-secret environment
   variable name.
9. Complete email verification through MCP.

Gemini owns provider authentication and history. Ambassador never receives the
provider credentials, central token, or DPoP private key. Never put the local
token or a provider credential in chat or registration arguments.
