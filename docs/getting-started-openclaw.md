# Get started with OpenClaw

## Before you start

- Install Node.js `>=24.19.0`.
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

1. With `ambassador start` still running, choose **Send to a webhook** during
   registration. Ambassador responds with this setup command:

   ```sh
   npx --yes @embassys/ambassador@latest webhook-secret
   ```

   Ambassador creates the secret, encrypts it in its own owner-only state, and
   displays it. Repeating the command displays the same value; it does not
   rotate it.

2. Open OpenClaw's native hook configuration:

   ```sh
   openclaw config patch --stdin
   ```

   Paste this block with the displayed secret, then send end-of-file with
   `Ctrl-D`:

   ```json5
   {
     hooks: {
       enabled: true,
       token: "PASTE_AMBASSADOR_SECRET_HERE",
       path: "/hooks",
       allowedAgentIds: ["main"],
       allowRequestSessionKey: false,
     },
   }
   ```

   OpenClaw stores `hooks.token` in its owner-only configuration. Its native
   hook does not accept a SecretRef for this field. The secret does not enter a
   command argument, shell history, or model prompt.

3. Validate the configuration and restart the OpenClaw gateway:

   ```sh
   openclaw config validate
   openclaw gateway restart
   ```

   If the gateway runs in the foreground, stop and start that process instead.
   The local receiver URL is normally:

   ```text
   http://127.0.0.1:18789/hooks/agent
   ```

   Use the actual configured gateway port. A non-loopback receiver must use an
   HTTPS URL.

4. Retry `register_agent` with webhook selected and that URL. MCP carries only
   `delivery.mode` and `delivery.url`; it never carries the secret or a secret
   name.

Ambassador sends OpenClaw's native agent-hook body with the complete central
message inside a fixed untrusted-input prompt. It selects agent `main`, uses an
isolated session, suppresses announcement delivery, authenticates with the
generated bearer secret, and sends the central message ID as the idempotency
key. A webhook `200` proves that OpenClaw admitted the run. It does not prove
that the model later called Ambassador MCP. End-to-end checks must wait for the
correlated permission or action response.

If OpenClaw admits the run but the action times out, check that the agent's own
provider credential and Ambassador MCP entry are available to the gateway.
Ambassador does not receive either credential.

For local reruns, see [Reset local test state](development-reset.md).
