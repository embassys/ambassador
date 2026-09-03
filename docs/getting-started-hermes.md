# Get started with Hermes Agent

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and authenticate the latest Hermes Agent release.
- Make sure `hermes-acp` is on `PATH` for direct delivery.
- Ambassador never receives your provider credential.

## Set up direct delivery

1. From the directory Hermes may access, keep Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. Add `http://127.0.0.1:8787/mcp` as a Streamable HTTP MCP server in Hermes's
   normal MCP configuration. Do not configure authentication.
3. Start or restart Hermes so it sees the MCP server.
4. Ask Hermes to register your email; it calls Ambassador's `register_agent`
   tool.
5. Choose **Send directly to this Hermes agent**.
6. Enter the six-digit code sent to your email.

Ambassador will launch `hermes-acp` when a central message arrives. That is a
new gateway-managed session, not the chat used for registration.

## Use a webhook instead

- Before step 1, set the receiver secret in the same shell:

  ```sh
  export AMBASSADOR_WEBHOOK_SECRET="$(
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
  )"
  ```

- During registration, choose **Send to a webhook**.
- Give Hermes the HTTPS webhook URL and the variable name
  `AMBASSADOR_WEBHOOK_SECRET`.
- Hermes supplies `delivery.url` and `delivery.secret_env`; it never receives
  the secret value.

Ambassador selects this profile by the exact known MCP client name, then tries
the fixed `hermes-acp` ACP v1 contract for direct delivery. Reported client and
agent versions are diagnostic only. An incompatible release fails at startup,
ACP initialization, session creation, or delivery instead of being rejected by
a version list. See
[Qualification](qualification.md) for the artifact-specific compatibility
evidence.
