# Get started with Gemini CLI

Release target: `@embassys/ambassador@0.2.6`. The profile is source-reviewed
against Gemini CLI 0.58.0, and its exact ACP initialization contract passed.
Real-agent direct and webhook qualification remain open under the one-release
qualification exception in ADR 0015.

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

1. Install Node.js `>=24.19.0 <25`, then install and authenticate Gemini CLI
   0.58.0 using its normal setup. Ambassador never installs or updates Gemini.
2. For noninteractive provider authentication, set the appropriate approved
   Gemini or Vertex variables outside chat. The profile accepts
   `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
   `GOOGLE_CLOUD_LOCATION`, and `GOOGLE_GENAI_USE_VERTEXAI`.
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

6. Configure Gemini CLI's MCP client to use the loopback endpoint printed by
   Ambassador, with a bearer token read from `AMBASSADOR_LOCAL_TOKEN`. Use the
   provider's normal MCP configuration mechanism; do not copy the token value
   into chat.
7. Ask Gemini CLI to register with your email and optional display name. The
   first `register_agent` call contains `email` and, if wanted, `display_name`.
   Ambassador recognizes the Gemini CLI profile and asks direct versus webhook,
   with direct as the default.
8. For direct mode, choose direct. The follow-up repeats the same `email` and
   optional `display_name` and adds `delivery: {"mode":"direct"}`. Ambassador
   starts `gemini --acp` and injects its authenticated HTTP MCP server into the
   new ACP session.
9. For webhook mode, choose webhook and provide the HTTPS receiver URL plus
   the environment-variable name `AMBASSADOR_WEBHOOK_SECRET`. The follow-up
   repeats the registration fields and adds `delivery.mode`, `delivery.url`,
   and `delivery.secret_env`; it never sends the secret value.
10. Enter the email verification code when Gemini CLI asks for it. Gemini CLI
    calls `verify_email` with that `email` and six-digit `code`; the central
    token and DPoP key stay inside Ambassador.

Gemini owns provider authentication and history. Ambassador never receives the
provider credentials, central token, or DPoP private key. Never put the local
token or a provider credential in chat or registration arguments.
