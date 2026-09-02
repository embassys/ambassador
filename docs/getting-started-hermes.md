# Get started with Hermes Agent

Status: implementation candidate; source-reviewed against Hermes Agent 0.21.0,
with real-agent qualification still required before publication

Ambassador enables Hermes only for this exact contract:

| Field | Value |
| --- | --- |
| MCP `clientInfo` | `mcp` / `0.1.0` |
| Delivery modes | direct and webhook |
| Direct command | `hermes-acp` |
| Accepted ACP `agentInfo` | `hermes-agent` / `0.21.0` |
| Ambassador MCP in the direct session | ACP HTTP MCP injection |

The contract was reviewed at Hermes revision
`1cb3ab617363ffab9e55239a7d2ab0d6f9c10473`. Hermes pins Python MCP 2.0.0 and
constructs `ClientSession` without overriding its client identity in
[`mcp_tool.py`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/tools/mcp_tool.py).
That SDK's exact `mcp` / `0.1.0` identity is defined by Python MCP 2.0.0's
[`DEFAULT_CLIENT_INFO`](https://github.com/modelcontextprotocol/python-sdk/blob/6f69a3758ebf2ee55ce050f58b470ce11af71133/src/mcp/client/session.py).
Hermes declares the `hermes-acp` entry point in
[`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/pyproject.toml)
and returns its ACP identity in
[`acp_adapter/server.py`](https://github.com/NousResearch/hermes-agent/blob/1cb3ab617363ffab9e55239a7d2ab0d6f9c10473/acp_adapter/server.py).
Later versions fail closed until the registry is reviewed and updated.

## Setup

1. Install and authenticate the supported Hermes version using its normal
   provider setup. Ambassador never installs or updates Hermes.
2. Generate a 48-character lowercase hexadecimal local token and export it,
   for example as `AMBASSADOR_LOCAL_TOKEN`.
3. Start Ambassador from the directory the direct agent may access:

   ```sh
   ambassador start --local-token-env=AMBASSADOR_LOCAL_TOKEN
   ```

4. Configure Hermes to call the printed loopback MCP endpoint with
   `Authorization: Bearer <local-token>` for registration.
5. Ask Hermes to call `register_agent`. The first call asks direct versus
   webhook and advertises direct as the default.
6. For direct mode, make the follow-up with `delivery.mode` set to `direct`.
   Ambassador starts `hermes-acp` and injects its authenticated HTTP MCP server
   into the gateway-owned ACP session.
7. For webhook mode, configure an authenticated receiver for the canonical
   Ambassador message and supply only its URL and webhook-secret environment
   variable name.
8. Complete email verification through MCP.

Hermes receives neither the central token nor the DPoP private key. Never put
the local token or webhook secret in chat or registration arguments.

The opt-in real-agent runner injects its qualification MCP endpoint into the
Hermes ACP session and verifies the exact reviewed `clientInfo` when Hermes
calls the bounded qualification tool.
