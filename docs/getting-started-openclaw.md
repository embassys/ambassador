# Get started with OpenClaw

## 1. Start Ambassador

- Install Node.js `>=24.19.0` and OpenClaw.
- Sign in to OpenClaw normally.
- In the directory OpenClaw may access, run:

  ```sh
  npx --yes @embassys/ambassador@latest start
  ```

- Keep that terminal open.

## 2. Add Ambassador to OpenClaw

Choose either method.

### Command

Run this in another terminal:

```sh
openclaw mcp set ambassador \
  '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","enabled":true}'
openclaw mcp doctor ambassador --probe
```

### Control UI

- Open the OpenClaw Control UI.
- Choose **MCP** or open `/settings/mcp`.
- Add `ambassador` with transport **Streamable HTTP** and URL
  `http://127.0.0.1:8787/mcp`.
- Leave authentication empty, save and publish, then restart or reload the
  owning agent runtime.

## 3. Register

- Start a fresh OpenClaw chat.
- Say: **Register me with Embassys using me@example.com.**
- Choose **Send directly to this OpenClaw agent** (the default) or **Send to a
  webhook**.
- Give OpenClaw the six-digit code sent to your email.

Later, you can ask:

- **Which Embassys permission requests are waiting for my approval?** Then tell
  OpenClaw which one to grant or deny.
- **Which Embassys actions are waiting for my answer?** Then give OpenClaw the
  requested value so it can submit the result.

## Direct delivery

Ambassador launches `openclaw acp` for incoming messages. OpenClaw does not
accept MCP session injection, so keep the MCP entry above enabled. The incoming
message runs in a new Ambassador-managed session, not the registration chat.
Ambassador does not disable OpenClaw's normally configured tools.

## Optional webhook delivery

1. During registration, choose **Send to a webhook**.
2. In another terminal, get Ambassador's receiver secret:

   ```sh
   npx --yes @embassys/ambassador@latest webhook-secret
   ```

3. Run `openclaw config patch --stdin`, paste the block below with the secret,
   then send end-of-file with `Ctrl-D`:

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

4. Validate and restart:

   ```sh
   openclaw config validate
   openclaw gateway restart
   ```

5. Give the agent the receiver URL when it retries registration. The usual
   local URL is `http://127.0.0.1:18789/hooks/agent`; use the configured gateway
   port.

The registration tool sends only `delivery.url`, never the secret. OpenClaw
keeps the secret in owner-only configuration. A remote receiver must use HTTPS.
For a clean local registration test, see
[Reset local test state](development-reset.md).

The MCP steps follow OpenClaw's current
[official MCP instructions](https://docs.openclaw.ai/cli/mcp).
