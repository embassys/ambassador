# Get started with OpenClaw

Status: paused until the current REST integration completes

Do not use the published `0.2.6` gateway for a new OpenClaw setup. It uses a
superseded central contract.

After I02 through I05 are complete and a new development package is approved,
the setup will remain small:

1. Install the qualified Node.js 24 gateway package.
2. Generate one 48-character lowercase hexadecimal local secret.
3. Put that secret in an environment variable available to both the gateway
   and OpenClaw's MCP configuration.
4. Start the gateway with a literal-loopback OpenClaw webhook URL and the name
   of that environment variable.
5. Configure OpenClaw to use `http://127.0.0.1:8787/mcp` with
   `Authorization: Bearer <local-secret>`.
6. Register and verify through the local MCP tools.

The exact install command and supported OpenClaw version will be added only
after the packed live E2E passes. The gateway will use central REST directly;
OpenClaw will never receive the central token or DPoP key.

See the [implementation status](implementation-status.md) for current work.
