# Get started with Hermes Agent

Status: paused pending approval and publication of a qualified package

Do not use the published `0.2.6` gateway for a new Hermes setup. It uses a
superseded central contract.

The current source has passed live qualification. If a new development package
is approved, the setup will remain small:

1. Install the qualified Node.js 24 gateway package.
2. Generate one 48-character lowercase hexadecimal local secret.
3. Put that secret in an environment variable available to the gateway and
   Hermes MCP configuration.
4. Start the gateway with a literal-loopback Hermes webhook URL and the name
   of that environment variable.
5. Configure Hermes to use `http://127.0.0.1:8787/mcp` with the local bearer.
6. Register and verify through the local MCP tools.

The gateway's webhook continues to send bearer and HMAC V2 authentication.
The packed live E2E has passed. The exact install command and supported Hermes
version still require a separate package and runtime qualification. Hermes
never receives the central token or DPoP key.

See [Current work](implementation-plan.md) for publication status.
