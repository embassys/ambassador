# Get started with Hermes Agent

Status: target setup; wait for the Ambassador delivery cutover and a qualified
package

Hermes will support two Ambassador delivery choices:

- **Webhook:** Configure an authenticated Hermes webhook that accepts the
  canonical Ambassador message JSON.
- **Direct:** Run Hermes's ACP interface under Ambassador and provide the
  authenticated Ambassador MCP endpoint through session configuration when the
  tested version supports it.

For either mode:

1. Install the qualified `@embassys/ambassador` package and supported Hermes
   version.
2. Generate a 48-character lowercase hexadecimal local token and expose it to
   Ambassador through an environment variable.
3. Start `ambassador start --local-token-env=<name>`.
4. Configure Hermes to call `http://127.0.0.1:8787/mcp` with the local bearer
   token.
5. Ask Hermes to register through MCP.
6. Choose direct or webhook when the registration result asks.
7. For webhook mode, provide only the webhook URL and secret
   environment-variable name. Never paste the secret into chat.
8. Complete email verification through the MCP tools.

The exact commands and supported versions will be added only after all four
OpenClaw/Hermes cases in [Delivery qualification](qualification.md) pass.
Hermes never receives the central token or DPoP private key.
