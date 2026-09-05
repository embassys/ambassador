# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol.md`
4. `docs/implementation-plan.md`
5. Relevant accepted records under `docs/adr/`, especially ADR 0037 for the
   central REST contract, ADR 0038 for local delivery, ADR 0039 for local
   startup and trust, ADR 0046 for pending actions, ADR 0050 for ACP sessions,
   ADR 0051 for received action results, ADR 0052 for the unified inbox, and
   ADR 0053 for live session inspection, ADR 0054 for Embassys permission
   decisions, ADR 0055 for ACP provider-tool approval, and ADR 0056 for scalable
   inboxes, explicit outbound intent, and peer sessions

The architecture and protocol describe the accepted target. The implementation
plan says which parts are not built yet. During the delivery cutover, replace
superseded behavior rather than preserving it for compatibility.

If a task conflicts with the accepted target, stop and ask. Do not expand the
scope on your own.

## Project rules

- ADR 0061 is the user's approved delivery cutover. It supersedes the older
  serial polling, ephemeral control-message custody, separate business tools,
  console-only diagnostics and prohibition on native origin bridges below.
  Implement the typed message box, independent durable receiver, structured
  owner input and qualified client-specific delivery. Read
  `docs/workflow-test-plan.md` before changing those boundaries. API work remains
  issue-only, and publication is not authorized.

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
- When `start` or `clean` finds a running Ambassador, an interactive terminal
  asks whether to stop it and proceed, with No as the default. Stop only the
  authenticated process instance the user confirmed, then acquire its released
  singleton lock. Non-interactive commands refuse. Do not force shutdown or
  stop an unrelated process occupying the port. See ADR 0058.
- Session commands are `sessions list`, `sessions show <session-id>` with an
  optional `--verbose`, `sessions delete <session-id>`, and `sessions forget
  <session-id>`. `list` and `show` work through the authenticated private
  control route while the foreground process runs. `delete` and `forget`
  require it to be stopped. Keep provider history out of local state.
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
  the webhook receiver, while central acknowledgement follows durable Ambassador custody independently.
- Direct mode makes Ambassador an ACP v1 client. It launches and controls the
  selected local agent and submits the complete message as an ACP prompt. It
  does not attempt to call back through the MCP connection that registered the
  identity.
- Require the exact ACP v1 protocol and compiled-in `agentInfo.name`, but treat
  `agentInfo.version` as diagnostic metadata. Attempt the fixed profile and let
  startup, initialization, session, or delivery incompatibility fail through
  the normal bounded error path.
- MCP remains the agent-to-Ambassador tool channel. Expose six stable tools:
  register_agent, verify_email, resend_verification, list_action_types,
  get_my_permissions and message_box. The typed message box replaces separate
  business tools and provides actions, permission-only requests, results,
  owner questions/answers, durable checks, inbox pages and explicit receipts.
  Reads never consume results. No local poll_messages, ack_message, permission
  decision, arbitrary conversation or delivery-control tool is exposed.
- Initial business calls and repeated user-driven checks wait up to 600 seconds.
  Timeout returns the same operation's continuation, never a scheduled retry.
  Permit an explicit shorter wait and keep wait capacity separate from ordinary
  tools. Stream supported MCP SSE responses without buffering the whole call.
- One independent receiver captures bounded batches durably. Processing,
  provider delivery and central acknowledgements run independently. ACP approval
  uses the shared encrypted response mailbox, never a competing central poller.
- Optional native return bridges capture destinations from trusted provider
  context and observe saved operations. OpenClaw uses reviewed chat.inject;
  Claude Code channels remain experimental. Hermes native return requires
  qualified origin and busy-session semantics. Never claim a desktop displayed
  a result from an HTTP acknowledgement alone.
- Direct-agent work is a persistent gateway-managed ACP session. It is not the
  exact chat in which registration happened. All supported agents load
  Ambassador MCP and other tools from normal provider configuration; send an
  empty `mcpServers` array through ACP.
- Keep provider built-in tools enabled and do not request safe mode, restricted
  mode, or permission bypass. When ACP requests tool permission, keep the ACP
  request open, call central `get_human_input` using the triggering message ID,
  send the provider's exact option names and IDs as the API button labels and
  values, consume the correlated `human_input_response` from `poll_messages`,
  and return the selected option ID unchanged. Reject choices that cannot fit
  the deployed API bounds; do not reinterpret approval kind or scope. Do not
  auto-approve and do not use `request_permission` for the provider approval.
- Reuse ACP sessions per central-issued remote identity, scoped to enrollment,
  fixed provider, and canonical working directory. Track message dispatch and
  each action separately; never replay a dispatched or uncertain message. Keep
  unfinished work active, clean idle sessions after 30 days in bounded batches,
  and delegate model compaction to the provider as defined by ADR 0056.
- Encrypted stores hold notification custody, pending calls, received results,
  outbound intent, operation events, owner questions and human-input responses.
  Each has a 1 GiB ciphertext quota and bounded indexed reads. Persist dispatch
  and receipt intent before external handoffs. Never replay uncertain prompts
  or mutations. Native route journals contain IDs and delivery state only.
  Use new schemas directly; migration is out of scope. Local custody cannot
  invent server redelivery or recover an HTTP response lost before receipt.
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
- The existing REST request_permission contract remains unchanged.
  message_box request_action saves exact outbound payload locally and requests
  the exact catalog action name. Validate the catalog schema without coercion,
  defaults or name mapping. Permission-only requests contain no action payload.
  A new permission request emails the grantor's human and queues no request to
  the grantor's agent. A grant alone supplies no action payload. Ambassador
  never handles emailed decision tokens in normal operation.
- Protected central requests send `Authorization: Bearer <token>` and a
  separate `DPoP: <proof>` header. A nonce is optional and is used only after
  the server supplies one.
- Persist the DPoP-bound token and P-256 private key only as one atomic
  encrypted credential. Never put either value in MCP arguments or results,
  URLs, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts,
  or support bundles.
- Development diagnostics always retain bounded request/response bodies and
  workflow events after credential redaction. Print the log directory at startup;
  rotate four files of at most 8 MiB, bound each record to 64 KiB, and preserve
  logs during clean. Verbose also prints to the console. Never log authorization,
  DPoP material, nonces, tokens, verification codes, private keys, cookies,
  webhook secrets or provider credentials. Logs are not recovery state.
  The user approved this detailed retention for the upcoming development release
  on 2026-09-05. Review retention separately for later production releases.
- Do not add old-client support, central MCP fallbacks, speculative versioned
  routes, credential migration, activation, token reissue, leases, general
  conversations or replies, or central outcome lookup unless the current
  server adds the behavior and the user accepts the client change.
- The local listener always binds to `127.0.0.1` and validates `Host` and
  `Origin` before parsing a request. The `/mcp` route trusts the owner's
  local-machine boundary, does not use bearer authentication, and rejects
  supplied `Authorization` headers. ADR 0053's non-MCP control route accepts
  bounded session reads and ADR 0058's instance-specific status and stop
  operations, rejects every Origin, and requires Ambassador's generated
  encrypted internal bearer secret.
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
