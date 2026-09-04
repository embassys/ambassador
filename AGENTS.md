# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol.md`
4. `docs/implementation-plan.md`
5. Relevant accepted records under `docs/adr/`, especially ADR 0037 for the
   central REST contract, ADR 0038 for local delivery, and ADR 0039 for local
   startup and trust

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
- `start` accepts only the optional `--verbose` diagnostic flag. Do not add
  delivery-mode, agent, webhook URL, central URL, configuration path, token,
  or secret-value flags.
- `clean` accepts no options. It clears local Ambassador enrollment and
  delivery state only after proving the foreground process is stopped. It does
  not call central or change agent/provider configuration.
- Session commands are `sessions list`, `sessions show <session-id>` with an
  optional `--verbose`, `sessions delete <session-id>`, and `sessions forget
  <session-id>`. They require the foreground process to be stopped. Keep
  provider history out of local state.
- Resolve delivery during MCP registration through a fixed capability
  registry. The two modes are `webhook` and `direct`. Do not add a third
  connector or polling mode.
- Match the bounded MCP `clientInfo.name` exactly against reviewed client
  names. Treat `clientInfo.version` as bounded diagnostic metadata, not a
  compatibility gate. `clientInfo` is not authenticated identity, but it may
  select only a compiled-in profile whose command, arguments, capabilities,
  and qualification are fixed. Never accept an agent kind, executable,
  arguments, adapter, or working directory from MCP input.
- Direct is the default. A complete direct-only profile proceeds without a
  delivery question. Ask direct versus webhook only for a complete dual-mode
  profile, and present direct as the default. Only OpenClaw and Hermes are
  dual-mode. Codex and Claude Code are direct-only and proceed without a
  delivery question.
- Reject an unknown, ambiguous, or incomplete profile before creating local or
  central registration state. Do not offer a generic webhook fallback. Keep the
  fixed Codex and Claude Code commands and ACP agent names approved in ADR
  0050; do not substitute adapters or accept arbitrary agent names. Provider
  agents apply their own authentication policy. Ambassador does not initiate
  login or inspect, store, log, or return provider credentials.
- A persisted profile derived from the matched capability entry and any
  required user choice is authoritative.
- Webhook registration accepts only a URL after the owner creates Ambassador's
  encrypted receiver secret with `ambassador webhook-secret`. The secret value
  never enters MCP. The gateway sends the complete validated central message
  with the profile's fixed authentication. A `2xx` transfers responsibility to
  the webhook receiver, after which the gateway acknowledges central.
- Direct mode makes Ambassador an ACP v1 client. It launches and controls the
  selected local agent and submits the complete message as an ACP prompt. It
  does not attempt to call back through the MCP connection that registered the
  identity.
- Require the exact ACP v1 protocol and compiled-in `agentInfo.name`, but treat
  `agentInfo.version` as diagnostic metadata. Attempt the fixed profile and let
  startup, initialization, session, or delivery incompatibility fail through
  the normal bounded error path.
- MCP remains the agent-to-Ambassador tool channel. Do not expose delivery
  control through local `poll_messages` or `ack_message` tools after the
  cutover. Expose the exact central `submit_action_result` operation for the
  target of an action call and the local `list_pending_action_calls` view from
  ADR 0046. Do not treat either as a general chat or delivery-control tool.
- Direct-agent work is a persistent gateway-managed ACP session. It is not the
  exact chat in which registration happened. All supported agents load
  Ambassador MCP and other tools from normal provider configuration; send an
  empty `mcpServers` array through ACP.
- Keep provider built-in tools enabled and do not request safe mode, restricted
  mode, or permission bypass. When ACP requests tool permission, choose
  `allow_once` when offered, otherwise choose the first positive option.
- Store only bounded ACP session metadata. Retire non-action sessions after a
  normal turn and action sessions after central accepts their correlated
  result. Delete or forget retired sessions after 30 days as defined by ADR
  0050.
- Keep the notification journal ID-only. The sole local body-persistence
  exception is ADR 0046's encrypted pending-action inbox: capture only the
  validated action-call fields and remove them after a successful
  `submit_action_result`. Keep every other central message body in bounded
  memory; do not invent server redelivery.
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
- Verbose diagnostics are console-only and may include bounded message, MCP,
  and REST data after mandatory credential redaction. Never print
  authorization, DPoP material, nonces, tokens, verification codes, private
  keys, cookies, or webhook secrets.
- Do not add old-client support, central MCP fallbacks, speculative versioned
  routes, credential migration, activation, token reissue, leases, general
  conversations or replies, or outcome lookup unless the current server adds
  the behavior and the user accepts the client change.
- The local MCP listener always binds to `127.0.0.1` and validates `Host` and
  `Origin` before parsing a request. It trusts the owner's local-machine
  boundary, does not use bearer authentication, and rejects supplied
  `Authorization` headers.
- Generate the central credential's encryption material internally and keep it
  in a separate owner-only state file. Never send it to an agent or accept it
  through CLI, MCP, or the environment.
- Write or update tests and CI expectations before production implementation.
  CI delivery tests use a mock webhook receiver and a mock ACP v1 agent. Real
  OpenClaw, Hermes, Codex, and Claude Code tests are explicit local
  qualification, not CI.
- Do not select or install a framework, library, runtime, package manager,
  database driver, or build tool without explicit user approval. ACP v1,
  exact `@agentclientprotocol/sdk` 1.4.0, and the public Codex and Claude ACP
  adapters declared through unpinned npm wildcards are approved by ADRs 0038
  and 0050.
- Get user approval for any further CLI change before writing CLI tests or
  code. Get user approval before adding publication or installation tooling.
- Record approved architecture and dependency changes under `docs/adr/`.
- Keep open Ambassador work in `docs/implementation-plan.md` and optional
  server work in `docs/central-follow-ups.md`. Do not leave completed work as a
  TODO.
- A health response and fixture success do not prove live compatibility. Run
  the controlled live qualification for client-visible server changes.
- GUI work and a production central MCP client remain out of scope.
