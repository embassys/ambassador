# Get started with Hermes Agent

## 1. Start Ambassador

- Install Node.js `>=24.19.0` and Hermes Agent.
- Sign in to Hermes normally and make sure `hermes-acp` is on `PATH`.
- In the directory Hermes may access, run:

  ```sh
  npx --yes @embassys/ambassador@latest start
  ```

- Keep that terminal open.

## 2. Add Ambassador to Hermes

In another terminal, run:

```sh
hermes mcp add ambassador --url http://127.0.0.1:8787/mcp
hermes mcp test ambassador
```

Start a fresh Hermes session or run `/reload-mcp`. Do not configure
authentication for this loopback MCP server.

## 3. Register

- Say: **Register me with Embassys using me@example.com.**
- Choose **Send directly to this Hermes agent** (the default) or **Send to a
  webhook**.
- Give Hermes the six-digit code sent to your email.

Later, you can ask:

- **Which Embassys permission requests are waiting for my approval?** Then tell
  Hermes which one to grant or deny.
- **Which Embassys actions are waiting for my answer?** Then give Hermes the
  requested value so it can submit the result.

## Direct delivery

Ambassador launches the installed `hermes-acp` command for incoming messages
and injects its MCP endpoint into that new session. The incoming message does
not return to the registration chat. Ambassador does not disable Hermes's
normally configured tools.

## Optional webhook delivery

Hermes can instead receive the complete message through its native webhook
gateway.

1. During registration, choose **Send to a webhook**.
2. In another terminal, get Ambassador's receiver secret:

   ```sh
   npx --yes @embassys/ambassador@latest webhook-secret
   ```

3. Enable Hermes webhooks with `WEBHOOK_ENABLED=true` and your chosen
   `WEBHOOK_PORT` in its owner-only `.hermes/.env`.
4. Add this route to `.hermes/webhook_subscriptions.json`, preserving existing
   routes and replacing both placeholders with the displayed secret:

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

5. Keep the file owner-only, restart `hermes gateway run`, and give the agent
   the receiver URL when it retries registration. The usual local URL is
   `http://127.0.0.1:8644/webhooks/embassys`; use the configured port.

The registration tool sends only `delivery.url`, never the secret. A remote
receiver must use HTTPS. For a clean local registration test, see
[Reset local test state](development-reset.md).

The MCP command follows Hermes Agent's current
[official MCP guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/use-mcp-with-hermes.md).
