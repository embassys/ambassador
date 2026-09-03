# Get started with OpenClaw

Release target: `@embassys/ambassador@0.2.6`. The profile is source-reviewed
against OpenClaw 2026.8.1. Real-agent direct and webhook qualification remain
open under the one-release qualification exception in ADR 0015.

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

1. Install Node.js `>=24.19.0 <25`, then install and authenticate OpenClaw
   2026.8.1 using its normal provider setup. Ambassador never installs or
   updates OpenClaw.
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

5. Configure OpenClaw's MCP client to use the loopback endpoint printed by
   Ambassador, with a bearer token read from `AMBASSADOR_LOCAL_TOKEN`.
   OpenClaw's ACP interface does not accept session MCP injection, so this
   normal provider configuration is also required for direct delivery.
6. Ask OpenClaw to register with your email and optional display name. The
   first `register_agent` call contains `email` and, if wanted, `display_name`.
   Ambassador recognizes the OpenClaw profile and asks direct versus webhook,
   with direct as the default.
7. For direct mode, choose direct. The follow-up repeats the same `email` and
   optional `display_name` and adds `delivery: {"mode":"direct"}`. Ambassador
   records the canonical startup directory and rejects a later start from a
   different directory.
8. For webhook mode, choose webhook and provide the HTTPS receiver URL plus
   the environment-variable name `AMBASSADOR_WEBHOOK_SECRET`. The follow-up
   repeats the registration fields and adds `delivery.mode`, `delivery.url`,
   and `delivery.secret_env`; it never sends the secret value. Receiver-side
   conversion to an OpenClaw-native hook belongs outside Ambassador.
9. Enter the email verification code when OpenClaw asks for it. OpenClaw calls
   `verify_email` with that `email` and six-digit `code`; the central token and
   DPoP key stay inside Ambassador.

OpenClaw receives neither the central token nor the DPoP private key. Never put
the local token or webhook secret in chat or registration arguments.

For the opt-in real-agent suite, configure this same provider-side MCP entry at
`http://127.0.0.1:8787/mcp` using `AMBASSADOR_QUALIFICATION_LOCAL_TOKEN`; the
runner verifies that OpenClaw calls it with the exact reviewed `clientInfo`.
