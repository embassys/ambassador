# Get started with Hermes Agent

## Before you start

- Install Node.js `>=24.19.0 <25`.
- Install and authenticate Hermes Agent.
- Make sure `hermes-acp` is on `PATH` for direct delivery.
- Ambassador never receives your provider credential.

## Set up direct delivery

1. From the directory Hermes may access, keep the latest Ambassador running:

   ```sh
   npx --yes @embassys/ambassador@latest start
   ```

2. Add the endpoint printed by Ambassador as an unauthenticated Streamable
   HTTP MCP server:

   ```sh
   hermes mcp add ambassador \
     --url http://127.0.0.1:8787/mcp \
     --connect-timeout 15
   ```

   Replace the URL if Ambassador printed a different loopback port. Do not
   configure authentication.
3. Start or restart Hermes so it sees the MCP server.
4. Ask Hermes to register your email. It calls Ambassador's `register_agent`
   tool.
5. Choose **Send directly to this Hermes agent**.
6. Enter the six-digit code sent to your email.

Ambassador launches `hermes-acp` when a central message arrives. That is a new
gateway-managed session, not the chat used for registration. Reported versions
are diagnostic only: Ambassador tries the fixed ACP v1 command and exact
`hermes-agent` identity, then reports a bounded startup, initialization,
session, or delivery failure if they are incompatible.

## Set up webhook delivery

Hermes has a native generic webhook receiver. Configure one owner-controlled
route that uses the same value for Ambassador's bearer and HMAC V2 contract:

1. With Ambassador running, choose **Send to a webhook** during registration.
   Ambassador responds with:

   ```sh
   npx --yes @embassys/ambassador@latest webhook-secret
   ```

   Ambassador creates the secret, encrypts it in its own owner-only state, and
   displays it. Repeating the command displays the same value; it does not
   rotate it.

2. Enable Hermes webhooks with `WEBHOOK_ENABLED=true` and your chosen
   `WEBHOOK_PORT` in Hermes's owner-only `.hermes/.env`. Add this route to
   `.hermes/webhook_subscriptions.json`, replacing both placeholders with the
   displayed value and preserving any existing routes:

   ```json
   {
     "embassys": {
       "description": "Embassys Ambassador",
       "events": [],
       "filters": [
         {
           "field": "headers.Authorization",
           "equals": "Bearer PASTE_AMBASSADOR_SECRET_HERE"
         }
       ],
       "prompt": "",
       "skills": [],
       "deliver": "log",
       "secret": "PASTE_AMBASSADOR_SECRET_HERE"
     }
   }
   ```

   Keep the file mode `0600`. An empty prompt passes the complete canonical
   JSON to the model. The route uses Hermes's normal tool configuration, so
   keep the Ambassador MCP server enabled there.

3. Start or restart `hermes gateway run`. The local receiver URL is normally:

   ```text
   http://127.0.0.1:8644/webhooks/embassys
   ```

   Use the actual configured port. A non-loopback receiver must use an HTTPS
   URL.

4. Retry `register_agent` with webhook selected and that URL. MCP carries only
   `delivery.mode` and `delivery.url`; it never carries the secret or a secret
   name.

Hermes validates the bearer filter and HMAC V2 timestamp/signature before its
model runs. A webhook `2xx` proves custody only. Keep both Hermes and
Ambassador running until the model calls `respond_to_permission` or
`submit_action_result` and the requester receives the correlated response.

For local reruns, see [Reset local test state](development-reset.md).
