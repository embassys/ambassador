# Get started with Claude Code

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Use Claude Code `2.1.257` or `2.1.258`.
- For direct delivery, install `@agentclientprotocol/claude-agent-acp` `0.73.0`
  so `claude-agent-acp` is on `PATH`.
- Sign in to Claude Code normally. Ambassador never receives your Claude
  credential.

## Set up direct delivery

1. From the directory Claude Code may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@0.2.7 start
   ```

2. Add `http://127.0.0.1:8787/mcp` as a Streamable HTTP MCP server in Claude
   Code's normal MCP configuration. Do not configure authentication.
3. Start or restart Claude Code so it sees the MCP server.
4. Ask Claude Code to register your email; it calls Ambassador's
   `register_agent` tool.
5. Choose **Send directly to this Claude Code agent**.
6. Enter the six-digit code sent to your email.

Ambassador will launch `claude-agent-acp` when a central message arrives. That
is a new gateway-managed session, not the chat used for registration.

## Use a webhook instead

- Before step 1, set the receiver secret in the same shell:

  ```sh
  export AMBASSADOR_WEBHOOK_SECRET="$(
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
  )"
  ```

- During registration, choose **Send to a webhook**.
- Give Claude Code the HTTPS webhook URL and the variable name
  `AMBASSADOR_WEBHOOK_SECRET`.
- Claude Code supplies `delivery.url` and `delivery.secret_env`; it never
  receives the secret value.

Only the exact versions above are enabled. Other versions fail closed until
their capability profile is reviewed. See [Qualification](qualification.md)
for compatibility evidence.
