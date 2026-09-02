# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol.md`
4. `docs/implementation-plan.md`
5. Relevant accepted records under `docs/adr/`, especially ADR 0037 for the
   central REST contract and ADR 0038 for local delivery

The architecture and protocol describe the accepted target. The implementation
plan says which parts are not built yet. During the delivery cutover, replace
superseded behavior rather than preserving it for compatibility.

If a task conflicts with the accepted target, stop and ask. Do not expand the
scope on your own.

## Project rules

- The product and public npm package are `@embassys/ambassador`. The public
  binary is `ambassador`. Do not keep the old package or binary as aliases.
- One foreground Ambassador process owns one enrolled central identity and one
  local delivery profile.
- `start` accepts only `--local-token-env=<name>`. Do not add delivery-mode,
  agent, webhook URL, central URL, configuration path, or secret-value flags.
- Resolve delivery during MCP registration through a fixed capability
  registry. The two modes are `webhook` and `direct`. Do not add a third
  connector or polling mode.
- Match bounded MCP `clientInfo` metadata exactly against reviewed aliases.
  It is not authenticated identity, but it may select only a compiled-in
  profile whose command, arguments, capabilities, and qualification are
  fixed. Never accept an agent kind, executable, arguments, adapter, or
  working directory from MCP input.
- Direct is the default. A complete direct-only profile proceeds without a
  delivery question. Ask direct versus webhook only for a complete dual-mode
  profile, and present direct as the default. The enabled dual-mode profiles
  are OpenClaw, Hermes, Codex, Claude Code, and Gemini CLI.
- Reject an unknown, ambiguous, or incomplete profile before creating local or
  central registration state. Do not offer a generic webhook fallback. Keep the
  exact Codex, Claude Code, and Gemini CLI contracts approved in ADR 0038; do
  not substitute adapters or widen version matching.
- A persisted profile derived from the matched capability entry and any
  required user choice is authoritative.
- Webhook registration accepts a URL and a webhook secret environment-variable
  name, never the secret value. The gateway sends the complete validated
  central message with bearer and HMAC authentication. A `2xx` transfers
  responsibility to the webhook receiver, after which the gateway acknowledges
  central.
- Direct mode makes Ambassador an ACP v1 client. It launches and controls the
  selected local agent and submits the complete message as an ACP prompt. It
  does not attempt to call back through the MCP connection that registered the
  identity.
- MCP remains the agent-to-Ambassador tool channel. Do not expose delivery
  control through local `poll_messages` or `ack_message` tools after the
  cutover. Expose the exact central `submit_action_result` operation for the
  target of an action call. Do not treat it as a general chat reply tool.
- Direct-agent work is a gateway-managed ACP session. It is not the exact chat
  in which registration happened. Configure Ambassador MCP in that session
  when the agent supports session MCP injection; otherwise require normal
  provider configuration.
- Keep central message bodies in bounded memory and the notification journal
  ID-only. Do not invent local body persistence or server redelivery.
- The gateway follows the current
  [`embassys/agent2agent`](https://github.com/embassys/agent2agent) REST service
  at `https://mcp.embassys.ai`. Review current server code and live behavior
  before changing the integration. Update gateway code, fixtures, protocol,
  and qualification evidence together when the server contract changes.
- The gateway does not connect to central MCP, discover central MCP tools, put
  a token in MCP arguments, probe alternate routes, or select an API version at
  runtime.
- Registration, verification, and resend use `/api/register_agent`,
  `/api/verify_email`, and `/api/resend_verification`. Registration is
  email-based. Verification sends the generated P-256 public JWK in the JSON
  body and intercepts the returned token before generic result handling.
- Protected central requests send `Authorization: Bearer <token>` and a
  separate `DPoP: <proof>` header. A nonce is optional and is used only after
  the server supplies one.
- Persist the DPoP-bound token and P-256 private key only as one atomic
  encrypted credential. Never put either value in MCP arguments or results,
  URLs, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts,
  or support bundles.
- Do not add old-client support, central MCP fallbacks, speculative versioned
  routes, credential migration, activation, token reissue, leases, general
  conversations or replies, or outcome lookup unless the current server adds
  the behavior and the user accepts the client change.
- The local MCP listener always binds to `127.0.0.1`, validates `Host` and
  `Origin`, and authenticates before parsing a request.
- Write or update tests and CI expectations before production implementation.
  CI delivery tests use a mock webhook receiver and a mock ACP v1 agent. Real
  OpenClaw, Hermes, Codex, Claude Code, and Gemini CLI tests are explicit local
  qualification, not CI.
- Do not select or install a framework, library, runtime, package manager,
  database driver, or build tool without explicit user approval. ACP v1 and
  exact `@agentclientprotocol/sdk` 1.4.0 are approved by ADR 0038.
- Get user approval for any further CLI change before writing CLI tests or
  code. Get user approval before adding publication or installation tooling.
- Record approved architecture and dependency changes under `docs/adr/`.
- Keep open Ambassador work in `docs/implementation-plan.md` and optional
  server work in `docs/central-follow-ups.md`. Do not leave completed work as a
  TODO.
- A health response and fixture success do not prove live compatibility. Run
  the controlled live qualification for client-visible server changes.
- GUI work and a production central MCP client remain out of scope.
