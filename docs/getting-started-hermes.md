# Get started with Hermes Agent

Release target: `@embassys/ambassador@0.2.6`. The profile is source-reviewed
against Hermes Agent 0.21.0. Real-agent direct and webhook qualification remain
open under the one-release qualification exception in ADR 0015.

Ambassador enables Hermes only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `mcp` / `0.1.0` |
| Delivery modes | direct and webhook |
| Direct command | `hermes-acp` |
| Accepted ACP `agentInfo` | `hermes-agent` / `0.21.0` |
| Ambassador MCP in the direct session | ACP HTTP MCP injection |

The contract was reviewed at Hermes revision
`1cb3ab617363ffab9e55239a7d2ab0d6f9c10473`. Hermes pins Python MCP 2.0.0 and
constructs `ClientSession` without overriding its client identity in
[`mcp_tool.py`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/tools/mcp_tool.py).
That SDK's exact `mcp` / `0.1.0` identity is defined by Python MCP 2.0.0's
[`DEFAULT_CLIENT_INFO`](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/src/mcp/client/session.py).
Hermes declares the `hermes-acp` entry point in
[`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/pyproject.toml)
and returns its ACP identity in
[`acp_adapter/server.py`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/acp_adapter/server.py).
Later versions fail closed until the registry is reviewed and updated.

## Setup

1. Install Node.js `>=24.19.0 <25`, then install and authenticate Hermes Agent
   0.21.0 using its normal provider setup. Ambassador never installs or updates
   Hermes.
2. Generate the local MCP token without putting its value in chat or a command
   argument:

   ```sh
   export AMBASSADOR_LOCAL_TOKEN="$(
     node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
   )"
   ```

3. If you may choose webhook delivery, create its secret in the same shell
   before starting Ambassador:

   ```sh
   export AMBASSADOR_WEBHOOK_SECRET="$(
     node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
   )"
   ```

4. From the directory the direct agent may access, start the exact release and
   keep it running in the foreground:

   ```sh
   npx --yes @embassys/ambassador@0.2.6 start \
     --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

5. Configure Hermes to use the loopback MCP endpoint printed by Ambassador,
   with a bearer token read from `AMBASSADOR_LOCAL_TOKEN`. Use Hermes's normal
   MCP configuration mechanism; do not copy the token value into chat.
6. Ask Hermes to register with your email and optional display name. The first
   `register_agent` call contains `email` and, if wanted, `display_name`.
   Ambassador recognizes the Hermes profile and asks direct versus webhook,
   with direct as the default.
7. For direct mode, choose direct. The follow-up repeats the same `email` and
   optional `display_name` and adds `delivery: {"mode":"direct"}`. Ambassador
   starts `hermes-acp` and injects its authenticated HTTP MCP server into the
   gateway-owned ACP session.
8. For webhook mode, choose webhook and provide the HTTPS receiver URL plus
   the environment-variable name `AMBASSADOR_WEBHOOK_SECRET`. The follow-up
   repeats the registration fields and adds `delivery.mode`, `delivery.url`,
   and `delivery.secret_env`; it never sends the secret value.
9. Enter the email verification code when Hermes asks for it. Hermes calls
   `verify_email` with that `email` and six-digit `code`; the central token and
   DPoP key stay inside Ambassador.

Hermes receives neither the central token nor the DPoP private key. Never put
the local token or webhook secret in chat or registration arguments.

The opt-in real-agent runner injects its qualification MCP endpoint into the
Hermes ACP session and verifies the exact reviewed `clientInfo` when Hermes
calls the bounded qualification tool.
