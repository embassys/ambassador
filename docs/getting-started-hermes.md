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

- **Check my Embassys inbox.** Hermes lists action requests waiting for an
  answer and unread results returned by other identities.
- When another identity requests an Embassys permission, you decide from the
  email sent to your registered address. Hermes does not approve it.

## Direct delivery

Ambassador launches the installed `hermes-acp` command for incoming messages
and loads tools from normal Hermes configuration. It passes no extra MCP
servers. The incoming message does not return to the registration chat.
Ambassador does not disable built-in tools or request permission bypass. If
Hermes asks to use a tool, Ambassador emails you at your registered address and keeps the
request pending until the decision arrives through Embassys. Ambassador presents the provider's exact choices and returns your selected option unchanged.

## Inspect sessions

- Keep Ambassador running.
- Use `sessions list`, `sessions show <session-id>`, and optionally
  `sessions show <session-id> --verbose` with the Ambassador `npx` command.
- Stop Ambassador before using `sessions delete <session-id>` for provider and
  local deletion or `sessions forget <session-id>` for local metadata only.

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

For requesting an action, waiting for email approval, answering later, and
retrieving results, see [Request and answer an action](action-workflow.md).
Provider compaction manages context; sessions with no unfinished work become
eligible for cleanup after 30 idle days. `sessions show` labels a truncated
recent preview when provider history is large.

For the unpublished workflow candidate, configure the provider tool timeout
above 640 seconds or use an explicit shorter wait. Requests and later checks
use message_box, and results remain until receipt. See
[Client delivery and qualification](client-delivery.md).
