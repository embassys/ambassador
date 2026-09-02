# Get started with OpenClaw

Status: target setup; wait for the Ambassador delivery cutover and a qualified
package

OpenClaw will support two Ambassador delivery choices:

- **Webhook:** Configure an authenticated OpenClaw hook and a receiver-side
  mapping from Ambassador's canonical message JSON to OpenClaw's native agent
  hook input.
- **Direct:** Run OpenClaw's ACP interface under Ambassador. Configure the
  authenticated Ambassador MCP endpoint in OpenClaw before registration when
  the tested ACP interface does not accept session MCP configuration.

For either mode:

1. Install the qualified `@embassys/ambassador` package and supported
   OpenClaw version.
2. Generate a 48-character lowercase hexadecimal local token and expose it to
   Ambassador through an environment variable.
3. Start `ambassador start --local-token-env=<name>`.
4. Configure OpenClaw to call `http://127.0.0.1:8787/mcp` with the local
   bearer token.
5. Ask OpenClaw to register through MCP.
6. Choose direct or webhook when the registration result asks.
7. For webhook mode, provide only the hook URL and webhook secret
   environment-variable name. Never paste the secret into chat.
8. Complete email verification through the MCP tools.

The exact commands and supported versions will be added only after all four
OpenClaw/Hermes cases in [Delivery qualification](qualification.md) pass.
OpenClaw never receives the central token or DPoP private key.
