# 0038 Ambassador delivery modes

Status: accepted; local startup and MCP authentication amended by ADR 0039

Date: 2026-09-02

Updated: 2026-09-03

## Problem

The implemented gateway wakes one loopback webhook with only a message ID. A
separate connector then retrieves the body through MCP and controls a provider
through a provider-specific interface. That design no longer fits the product:

- the user wants webhook and direct agent delivery as first-class choices;
- a webhook can safely receive the complete message and accept custody;
- MCP is a request channel from an agent to the gateway, not a reverse channel
  that can wake the original chat later;
- ACP v1 provides a common client-to-agent invocation protocol;
- the central REST service has permission messages, action calls, and
  correlated action results but no general conversation, reply, or
  outcome-lookup routes; and
- maintaining separate connector products adds process, state, CLI, packaging,
  and documentation cost without adding a necessary trust boundary.

The public name also needs to move from the development package
"@a2adev/gateway" to "@embassys/ambassador".

## Decision

### One Ambassador process

Use one foreground Ambassador process for one enrolled central identity and one
local delivery profile. Fold direct agent invocation into Ambassador. Remove
the separate connector products during the implementation cutover.

The two delivery modes are:

1. "webhook", which transfers the complete message to an authenticated
   receiver; and
2. "direct", which submits the complete message to a gateway-managed agent over
   ACP v1.

There is no third polling or connector mode.

### Package and CLI

Rename the public npm package to "@embassys/ambassador" and its binary to
"ambassador". Do not retain old aliases or migration behavior.

The original startup command in this decision required a local-token option.
ADR 0039 removes that option; the current command is:

```text
ambassador start
```

Startup has no token, agent, delivery-mode, webhook URL, webhook secret,
central URL, or configuration-path option.

### Delivery selection during registration

Resolve delivery through `register_agent` before contacting central. Match the
MCP session's bounded `clientInfo` exactly against a compiled-in capability
registry. An enabled entry contains its exact aliases, supported delivery
modes, fixed direct executable and arguments, MCP setup behavior, version
policy, and qualification contract.

`clientInfo` is not authenticated identity. It is nevertheless sufficient to
select among fixed local profiles because it cannot add a profile, alter
process details, authorize central work, or widen capabilities. User and model
input never supplies an agent kind, executable, arguments, adapter, shell
command, transport, or working directory.

Direct is the default:

- A complete direct-only profile selects direct and continues without asking
  the user a delivery question.
- A complete dual-mode profile returns structured `input_required` content
  asking the user to choose direct or webhook, with direct identified as the
  default. The follow-up contains the mode and any mode-specific fields, not an
  agent kind.
- An unknown, ambiguous, disabled, or incomplete profile returns
  `unsupported_agent`. Ambassador writes no registration state and makes no
  central request.

The enabled dual-mode profiles are OpenClaw, Hermes, Codex, Claude Code, and
Gemini CLI. Their exact contracts appear below. Do not offer an arbitrary
command or a generic webhook fallback for an unsupported client. Do not fall
back from a failed direct launch to webhook.

The direct working directory is Ambassador's canonical process directory at
registration time. It persists in the profile. A later start from a different
directory fails closed instead of changing agent scope.

Webhook mode accepts a validated URL and the name of an environment variable
containing the receiver secret. The raw secret is configured outside the model.
It never appears in MCP arguments or results.

Persist only the nonsecret delivery profile derived from the matched registry
entry and, for a dual-mode entry, the user's choice. One profile belongs to one
central identity. There is no development-state migration or runtime profile
switching in this cutover.

### Webhook mode

Send the complete normalized central message as the canonical JSON body.
Preserve bearer authentication, HMAC V2 signing, timestamp, request ID,
idempotency key, body limits, deadline, and bounded pre-acceptance retries.

Permit HTTPS webhook URLs and literal-loopback HTTP URLs. Reject other
plaintext remote targets, credentials, fragments, redirects, and control
characters.

A 2xx response means that the receiver accepted custody of the complete
message. Record that boundary, then acknowledge the message to central. The
receiver does not call local "poll_messages" or "ack_message" for delivery
control.

The body is provider-neutral. OpenClaw, Hermes, or any other receiver owns its
mapping from the canonical Embassys message to a native hook shape.

### Direct mode

Ambassador is the ACP v1 client. Use exact
"@agentclientprotocol/sdk" 1.4.0, licensed Apache-2.0, as the protocol
implementation. The user approved ACP v1 and delegated the SDK choice.

For a selected profile, Ambassador launches one fixed executable and argument
set without a shell. Agent input and remote messages cannot select process
details. The child receives a minimal, reviewed environment and bounded
working directory.

An agent profile is enabled only after its exact aliases, invocation, version
policy, MCP behavior, and tests are committed. Ambassador never downloads an
adapter at runtime. A recognizable product name without that complete contract
is unsupported.

The enabled direct profiles are:

| Profile | Exact MCP `clientInfo` aliases | Fixed direct invocation | Required ACP `agentInfo` | Ambassador MCP setup |
| --- | --- | --- | --- | --- |
| OpenClaw | `openclaw-bundle-mcp` / `0.0.0` | `openclaw acp` | `openclaw-acp` / `2026.8.1` | provider configuration |
| Hermes | `mcp` / `0.1.0` | `hermes-acp` | `hermes-agent` / `0.21.0` | ACP session injection |
| Codex | `codex-mcp-client` / `0.149.0` or `0.152.1` | `codex-acp` from `@agentclientprotocol/codex-acp` 1.8.0 | `@agentclientprotocol/codex-acp` / `1.8.0` | ACP session injection |
| Claude Code | `claude-code` / `2.1.257` or `2.1.258` | `claude-agent-acp` from `@agentclientprotocol/claude-agent-acp` 0.73.0 | `@agentclientprotocol/claude-agent-acp` / `0.73.0` | ACP session injection |
| Gemini CLI | `gemini-cli-mcp-client` / `0.58.0` | `gemini --acp` | `gemini-cli` / `0.58.0` | ACP session injection |

Codex CLI does not expose native ACP in the reviewed versions. The selected
Apache-2.0 adapter starts Codex App Server, translates ACP v1, and accepts HTTP
MCP session configuration. The adapter includes a compatible `@openai/codex`
dependency. Ambassador does not pass `CODEX_PATH`, `CODEX_CONFIG`, or another
process or session override from its environment. It may pass the reviewed
Codex and OpenAI API-key variables, along with the common provider environment,
so the agent can use its own authentication.

Claude Code uses the selected Apache-2.0 ACP adapter and its exact
`@anthropic-ai/claude-agent-sdk` 0.3.257 dependency. That SDK contains Claude
Code 2.1.257, while the separately reviewed current Claude Code client is
2.1.258. Both exact MCP identities are aliases for the same fixed profile.
Ambassador passes only the reviewed Anthropic authentication variables and the
common provider environment. It does not pass a Claude executable override.

Gemini CLI 0.58.0 supplies native ACP v1 through `gemini --acp`; Ambassador
does not add an adapter. Its reviewed session implementation accepts the HTTP
MCP configuration. The profile permits Gemini API-key authentication and the
reviewed Google Vertex selection variables. Other Gemini versions fail closed.

Ambassador initializes ACP, creates or safely resumes a gateway-owned session,
and submits one prompt containing fixed untrusted-input instructions plus the
complete canonical central message.

Ambassador has no interactive approval UI during background delivery. It does
not auto-approve ACP permission requests. The selected agent must rely on its
preconfigured policy and Ambassador MCP tools; any remaining permission request
is denied.

Ambassador supplies its loopback MCP endpoint in ACP session configuration
where the agent supports it. If an agent rejects session MCP configuration, its
normal local setup must configure Ambassador MCP before direct mode is used.

The ACP session is not the MCP chat in which the user registered. Registration
does not create a reverse call path to an existing chat.

A normal terminal ACP result permits central acknowledgement. If startup fails
before prompt dispatch, a bounded retry is allowed. If prompt dispatch may have
happened and the terminal result is lost, the outcome is uncertain and the
message is not automatically submitted again.

For an `action_call`, the agent uses the Ambassador `submit_action_result` MCP
tool before finishing. It supplies the received `call_id`, one structured
result, and `success` or `error`. Central authorizes the original target,
updates the call, and sends an `action_response` to the original caller.

Ambassador does not turn free-form provider output into the result. It discards
that output after bounded processing. The result operation is not a general
chat reply and cannot be used without an action call.

### MCP catalog

MCP remains the agent-to-Ambassador business tool channel. After enrollment,
the target catalog keeps action listing, permission request and decision,
action call, action-result submission, and permission listing.

Remove local "poll_messages" and "ack_message" after automatic delivery owns
those operations. Do not present `submit_action_result` as a general reply or
completion tool.

### Custody and restart behavior

Keep central message bodies in bounded memory. Keep the journal ID-only. The
delivery profile may contain only nonsecret mode, endpoint, agent-kind, secret
environment-variable name, canonical direct working directory, and safe opaque
session metadata.

The server consumes messages when polling returns them and cannot retrieve or
redeliver a delivered body. A process crash can therefore lose an in-memory
message. This accepted development limitation does not justify storing message
bodies locally.

### Qualification

CI uses a mock authenticated webhook receiver and a deterministic mock ACP v1
agent. The mocks cover the full delivery contract, failure boundaries,
acknowledgement order, crash uncertainty, and content-free durability without
network or paid agent accounts.

An opt-in local suite runs every enabled agent in this ten-case matrix:

| Agent | Webhook | Direct |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |
| Codex | required | required |
| Claude Code | required | required |
| Gemini CLI | required | required |

The local suite uses the central fixture by default. It records versions and
safe pass/fail evidence, never prompts, messages, credentials, or provider
output. A source or container contract probe does not replace a real
authenticated prompt and MCP call.

Live central qualification remains a separate controlled test for email,
DPoP, REST schemas, permissions, action results, consuming polls, and
acknowledgement.

## Consequences

- OpenClaw, Hermes, Codex, Claude Code, and Gemini CLI users choose delivery in
  the same agent conversation used for enrollment, with direct as the default.
- Complete direct-only profiles can enroll without an unnecessary delivery
  question.
- Unknown and incomplete clients fail before local or central registration
  state exists.
- The command line no longer contains delivery configuration.
- Raw webhook secrets stay outside model context.
- Webhook receivers get enough data to act without calling delivery-control
  MCP tools.
- Direct agents have one standard invocation boundary instead of custom
  provider transports.
- Ambassador now owns local agent process safety and ACP lifecycle.
- Real provider compatibility is a qualification claim, not an inference from
  a product name or model-supplied field.
- The package gains one exact ACP SDK dependency after red tests approve its
  use.
- The implementation can delete substantial connector code, state, tests, and
  documentation.

## Superseded decisions

This record supersedes:

- ADR 0017's webhook-only product boundary and startup interface;
- ADRs 0024 and 0028 through 0031's separate connector architecture, CLI,
  correlation database, execution contract, and package layout;
- ADRs 0034 and 0035's provider-specific Codex and Claude transports; and
- ADR 0036's rejected Gemini headless interface. Gemini now uses native ACP.

ADR 0015 is amended for the new package and binary names. ADRs 0019 and 0037
remain authoritative for central credential custody and the central REST
contract.

## Alternatives

- **Keep the ID-only webhook and local polling tools.** Rejected because the
  receiver can accept the complete validated message directly.
- **Keep a separate connector process.** Rejected because ACP provides the
  required invocation boundary inside Ambassador and the extra product adds no
  necessary credential separation.
- **Use the existing MCP session as the callback channel.** Rejected because
  MCP does not provide a durable reverse invocation path to the registration
  chat.
- **Put agent selection on `start`.** Rejected because Ambassador resolves a
  fixed profile from MCP `clientInfo` during registration and persists it.
- **Ask every client to choose an agent.** Rejected because the MCP session
  already provides bounded `clientInfo`, while an agent-kind argument would
  let model input influence process selection.
- **Accept webhook details from unknown clients.** Rejected for the first
  version because it weakens the fixed support boundary and makes unsupported
  callers appear qualified.
- **Pass the webhook secret through MCP.** Rejected because the model should
  handle only the environment-variable name.
- **Send provider-specific webhook bodies.** Rejected because provider mapping
  belongs at the receiver and would couple Ambassador to webhook products.
- **Persist message bodies for restart recovery.** Rejected because server-side
  retrieval or redelivery is the proper reliability boundary.

## Approval

The user approved the two delivery modes, guided MCP registration, full-message
webhooks, gateway-owned ACP v1 direct mode, no agent startup flag, package
rename, deterministic mock CI coverage, and local OpenClaw/Hermes qualification
as the initial qualification scope on 2026-09-02. The same day, the user
clarified that direct is the default, only supported dual-mode profiles ask the
delivery question, agent selection comes from the fixed `clientInfo` registry
rather than tool input, and unknown agents are rejected in this version.

On 2026-09-02, the user approved the exact Codex, Claude Code, and Gemini CLI
ACP profiles above, including the two external Apache-2.0 adapters. The user
also approved isolated copies of existing provider configuration or disposable
provider credentials for local qualification. This approval does not permit
Ambassador to install adapters at runtime, copy credentials into its state, or
relax exact version matching.

On 2026-09-03, the user approved adopting central's deployed
`submit_action_result` route and requested a live result round trip between a
controlled requester and real Codex.
