# Get started with OpenClaw

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and authenticate the latest OpenClaw release.
- Make sure `openclaw` is on `PATH` for direct delivery.
- Ambassador never receives your provider credential.

## Set up direct delivery

1. From the directory OpenClaw may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. Add `http://127.0.0.1:8787/mcp` as a Streamable HTTP MCP server in
   OpenClaw's normal MCP configuration. Do not configure authentication.
3. Start or restart OpenClaw so it sees the MCP server.
4. Ask OpenClaw to register your email; it calls Ambassador's `register_agent`
   tool.
5. Choose **Send directly to this OpenClaw agent**.
6. Enter the six-digit code sent to your email.

Ambassador will launch `openclaw acp` when a central message arrives. OpenClaw
does not accept session MCP injection, so keep the provider-side MCP entry from
step 2 configured.

## Use a webhook instead

- Before step 1, set the receiver secret in the same shell:

  ```sh
  export AMBASSADOR_WEBHOOK_SECRET="$(
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
  )"
  ```

- During registration, choose **Send to a webhook**.
- Give OpenClaw the HTTPS webhook URL and the variable name
  `AMBASSADOR_WEBHOOK_SECRET`.
- OpenClaw supplies `delivery.url` and `delivery.secret_env`; it never receives
  the secret value.

Ambassador selects this profile by the exact known MCP client name, then tries
the fixed `openclaw acp` ACP v1 contract for direct delivery. Reported client
and agent versions are diagnostic only. An incompatible release fails at
startup, ACP initialization, session creation, or delivery instead of being
rejected by a version list. See
[Qualification](qualification.md) for compatibility evidence.
