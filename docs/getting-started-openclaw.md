# Get started with OpenClaw

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and authenticate OpenClaw.
- Make sure `openclaw` is on `PATH` for direct delivery.
- Ambassador never receives your provider credential.

## Set up direct delivery

1. From the directory OpenClaw may access, keep the latest Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. Add the endpoint printed by Ambassador as an unauthenticated Streamable
   HTTP MCP server, then probe it:

   ```sh
   openclaw mcp set ambassador \
     '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","enabled":true}'
   openclaw mcp doctor ambassador --probe
   ```

   Replace the URL if Ambassador printed a different loopback port. Do not
   configure authentication.
3. Start or restart OpenClaw so it sees the MCP server.
4. Ask OpenClaw to register your email. It calls Ambassador's
   `register_agent` tool.
5. Choose **Send directly to this OpenClaw agent**.
6. Enter the six-digit code sent to your email.

Ambassador launches `openclaw acp` when a central message arrives. OpenClaw
does not accept session MCP injection, so keep the provider-side MCP entry from
step 2 configured. Reported versions are diagnostic only: Ambassador tries the
fixed ACP v1 command and exact `openclaw-acp` identity, then reports a bounded
startup, initialization, session, or delivery failure if they are incompatible.

## Set up webhook delivery

Webhook mode needs the receiver plugin shipped inside the latest Ambassador
package. Install Ambassador and the plugin once:

```sh
npm install --global @embassys/ambassador@latest
openclaw plugins install --accept-capabilities \
  "$(npm root --global)/@embassys/ambassador/integrations/openclaw-ambassador"
```

The capability is an exact authenticated HTTP route. Review and accept it only
from the Ambassador package you installed.

1. With `ambassador start` still running, choose **Send to a webhook** during
   registration. Ambassador responds with this setup command:

   ```sh
   ambassador webhook-secret
   ```

   Ambassador creates the secret, encrypts it in its own owner-only state, and
   displays it. Repeating the command displays the same value; it does not
   rotate it.

2. Store the displayed value in OpenClaw without putting it in shell history:

   ```sh
   openclaw secrets store set AMBASSADOR_WEBHOOK_SECRET --value-file -
   ```

   Paste the value, press Enter, then send end-of-file (`Ctrl-D`). Point the
   plugin at that store entry:

   ```sh
   openclaw config set plugins.entries.embassys-ambassador.config.secret \
     --ref-source store --ref-provider default \
     --ref-id AMBASSADOR_WEBHOOK_SECRET
   openclaw plugins enable embassys-ambassador --accept-capabilities
   ```

   The plugin starts the configured OpenClaw agent, which defaults to `main`.
   It does not select a model or expose the webhook secret to the model.

3. Restart the OpenClaw gateway and run `openclaw plugins doctor`. The local
   receiver URL is normally:

   ```text
   http://127.0.0.1:18789/embassys/ambassador
   ```

   Use the actual configured gateway port. A non-loopback receiver must use an
   HTTPS URL.

4. Retry `register_agent` with webhook selected and that URL. MCP carries only
   `delivery.mode` and `delivery.url`; it never carries the secret or a secret
   name.

The plugin verifies Ambassador's bearer token, exact-body HMAC V2 signature,
five-minute timestamp window, request ID, and idempotency key before placing the
message on a bounded in-memory service queue. That service starts the normal
OpenClaw model turn outside the completed HTTP request. A webhook `202` proves
that OpenClaw accepted custody. It does not by itself prove that the model later
called Ambassador MCP; end-to-end checks must wait for the correlated
permission or action response.

If OpenClaw reports `model execution failed`, run `openclaw plugins doctor` and
check that the agent's own provider credential and Ambassador MCP entry are
available to the OpenClaw gateway. Ambassador intentionally logs only a safe
failure category, not the provider error or message body.

For local reruns, see [Reset local test state](development-reset.md).
