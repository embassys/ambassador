# 0038 Ambassador delivery modes

Status: accepted; amended by ADRs 0039, 0040, 0041, 0042, 0043, 0045, 0046,
0047, 0048, 0049, 0050, 0051, and 0055

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
MCP session's bounded `clientInfo.name` exactly against a compiled-in
capability registry. Its reported version is observational under ADR 0041. An
enabled entry contains its exact client name, supported delivery modes, fixed
direct executable and arguments, exact ACP agent name, MCP setup behavior, and
qualification contract.

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

The enabled dual-mode profiles are OpenClaw and Hermes. Codex and Claude Code
are direct-only and proceed without a delivery question. Their exact contracts
appear below. Do not offer an arbitrary command or a generic webhook fallback
for an unsupported client. Do not fall back from a failed direct launch to
webhook.

The direct working directory is Ambassador's canonical process directory at
registration time. It persists in the profile. A later start from a different
directory fails closed instead of changing agent scope.

ADR 0042 replaces the environment-variable selector. Webhook mode accepts a
validated URL only after Ambassador has created its internal encrypted secret
through `ambassador webhook-secret`. The raw value is configured outside the
model and never appears in MCP arguments or results.

Persist only the nonsecret delivery profile derived from the matched registry
entry and, for a dual-mode entry, the user's choice. One profile belongs to one
central identity. There is no development-state migration or runtime profile
switching in this cutover.

### Webhook mode

Each dual-mode profile fixes a reviewed webhook format. Hermes receives the
complete normalized central message as the canonical JSON body with bearer
authentication, HMAC V2 signing, timestamp, request ID, and idempotency key.
OpenClaw receives its native `/hooks/agent` body with the complete message
inside fixed untrusted-input instructions. Its request fixes agent `main`, an
isolated session, and `deliver: false`, and authenticates with the bearer
secret plus the central message ID as the idempotency key. User or model input
cannot select a webhook format or native agent ID.

Permit HTTPS webhook URLs and literal-loopback HTTP URLs. Reject other
plaintext remote targets, credentials, fragments, redirects, and control
characters.

A 2xx response means that the receiver accepted custody of the complete
message. Record that boundary, then acknowledge the message to central. The
receiver does not call local "poll_messages" or "ack_message" for delivery
control.

Hermes retains the 512 KiB canonical-body limit. OpenClaw's native endpoint has
a 256 KiB request-body limit and does not accept Ambassador's HMAC V2 headers.
ADR 0042 uses that endpoint directly and removes the package-shipped OpenClaw
receiver.

### Direct mode

Ambassador is the ACP v1 client. Use exact
"@agentclientprotocol/sdk" 1.4.0, licensed Apache-2.0, as the protocol
implementation. The user approved ACP v1 and delegated the SDK choice.

For a selected profile, Ambassador launches one fixed executable and argument
set without a shell. Agent input and remote messages cannot select process
details. Each profile fixes its environment policy and working directory. Most
profiles use a minimal allowlist. ADR 0048 makes the built-in Claude bridge
inherit Ambassador's environment so the official CLI retains every native
authentication method.

On Windows, ADR 0040 keeps the no-shell rule. For a reviewed Node agent,
Ambassador validates the fixed package name, bin mapping, and JavaScript
entrypoint from the capability registry, then launches that entrypoint with its
current Node executable. The installed package version is bounded diagnostic
metadata under ADR 0041. Native executables retain their fixed command.

An agent profile is enabled only after its exact client and ACP agent names,
invocation, MCP behavior, and tests are committed. Ambassador never downloads
an adapter at runtime. A recognizable product name without that complete
contract is unsupported.

The enabled direct profiles are:

| Profile | Exact MCP client name | Fixed direct invocation | Required ACP agent name | Ambassador MCP setup |
| --- | --- | --- | --- | --- |
| OpenClaw | `openclaw-bundle-mcp` | `openclaw acp` | `openclaw-acp` | provider configuration |
| Hermes | `mcp` | `hermes-acp` | `hermes-agent` | ACP session injection |
| Codex | `codex-mcp-client` | `codex-acp` | `@agentclientprotocol/codex-acp` | ACP session injection |
| Claude Code | `claude-code` | Ambassador's built-in bridge, then `claude --print` | `@embassys/claude-cli-acp` | provider configuration |

Under ADR 0045, Ambassador installs the Apache-2.0 `codex-acp` adapter as an
exact production dependency. It starts Codex App Server, translates ACP v1,
and accepts HTTP MCP session configuration. Ambassador validates and runs the
dependency's fixed JavaScript entrypoint with its own Node executable; it does
not resolve a user-installed adapter from `PATH`. It does not pass
`CODEX_PATH`, `CODEX_CONFIG`, or another process or session override from its
environment. It may pass the reviewed Codex and OpenAI API-key variables,
along with the common provider environment, so the agent can use its own
authentication.

ADR 0047 replaces the Claude dependency selected in ADR 0045. Ambassador
launches its own bounded ACP v1 bridge, which in turn launches the fixed
official `claude` command in headless, non-persistent mode. ADR 0048 makes the
official CLI responsible for authentication and gives it the Ambassador
process environment unchanged. ADR 0049 removes Claude's safe and strict MCP
isolation so the background turn can use normally configured MCP tools.
Ambassador does not initiate login or inspect, store, log, or return provider
credentials or MCP configuration.

Gemini CLI and Antigravity are unsupported client names under ADR 0043. A
future profile requires a separately accepted fixed launch contract and live
qualification.

Ambassador initializes ACP, creates or safely resumes a gateway-owned session,
and submits one prompt containing fixed untrusted-input instructions plus the
complete canonical central message.

Ambassador has no interactive approval UI during background delivery. ADR 0055
defines the current policy: hold an ACP permission request open, ask the local
agent's own owner through central `get_human_input`, and return the correlated
polled answer to ACP.

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
tool when it can provide the result without guessing. It supplies the received
`call_id`, one structured result, and `success` or `error`. Central authorizes
the original target, updates the call, and sends an `action_response` to the
original caller. ADR 0046 lets the agent leave a call pending when user input
is unavailable and makes that call available in a later MCP session.

Ambassador does not turn free-form provider output into the result. It discards
that output after bounded processing. The result operation is not a general
chat reply and cannot be used without an action call.

### MCP catalog

MCP remains the agent-to-Ambassador business tool channel. After enrollment,
the target catalog keeps action listing, permission request and decision,
action call, action-result submission, permission listing, and a local
projection of pending requests the enrolled identity can decide. ADR 0046 adds
a separate encrypted local projection of unanswered action calls. ADR 0051
adds another encrypted projection for received action results.

Remove local "poll_messages" and "ack_message" after automatic delivery owns
those operations. Do not present `submit_action_result` as a general reply or
completion tool.

### Custody and restart behavior

Keep central message bodies in bounded delivery memory and keep the
notification journal ID-only. ADR 0046 persists validated unanswered
action-call fields in one encrypted local inbox until their result succeeds.
ADR 0051 persists received action results in a second encrypted inbox for
later MCP retrieval. The delivery profile may contain only nonsecret mode,
endpoint, agent kind, canonical direct working directory, and safe opaque
session metadata. ADR 0042 stores webhook authentication separately as an
encrypted secret and wrapping key.

The server consumes messages when polling returns them and cannot retrieve or
redeliver a delivered body. A process crash can therefore lose an in-memory
message. This accepted development limitation does not justify storing message
bodies locally beyond ADRs 0046 and 0051 or using either inbox as a redelivery
queue.

### Qualification

CI uses a mock authenticated webhook receiver and a deterministic mock ACP v1
agent. The mocks cover the full delivery contract, failure boundaries,
acknowledgement order, crash uncertainty, and content-free durability without
network or paid agent accounts.

An opt-in local suite runs every enabled mode in this six-case matrix:

| Agent | Webhook | Direct |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |
| Codex | not supported | required |
| Claude Code | not supported | required |

The local suite uses the central fixture by default. It records versions and
safe pass/fail evidence, never prompts, messages, credentials, or provider
output. A source or container contract probe does not replace a real
authenticated prompt and MCP call.

The installed-command version probe is observational. It records a bounded
semantic version or `unavailable` for every fixed profile and never skips a
delivery case because of that observation. Production requires ACP v1 and the
exact compiled-in `agentInfo.name`; it does not gate on the reported agent
version. MCP profile selection likewise requires the exact compiled-in client
name and does not gate on the reported client version.

Live central qualification remains a separate controlled test for email,
DPoP, REST schemas, permissions, action results, consuming polls, and
acknowledgement.

## Consequences

- OpenClaw and Hermes users choose delivery in the same agent conversation used
  for enrollment, with direct as the default.
- Codex, Claude Code, and later complete direct-only profiles enroll without an
  unnecessary delivery question.
- Unknown and incomplete clients fail before local or central registration
  state exists.
- The command line no longer contains delivery configuration.
- Raw webhook secrets stay outside model context.
- Webhook receivers get the complete message without calling delivery-control
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
- ADR 0036's rejected Gemini headless interface. ADR 0043 supersedes the later
  native Gemini profile and defers Antigravity.

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
  not handle a credential or a credential selector.
- **Accept a webhook format or agent ID from registration input.** Rejected
  because webhook mapping belongs in the same fixed capability registry as the
  direct invocation contract.
- **Persist every message body for restart recovery.** Rejected because
  server-side retrieval or redelivery is the proper delivery-reliability
  boundary. ADR 0046 later approved encrypted unanswered action calls so the
  user can supply a result asynchronously. ADR 0051 later approved encrypted
  received action results so the requester can retrieve returned data.

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

On 2026-09-03, the user corrected the delivery registry at that time: only
OpenClaw and Hermes supported webhook. The then-enabled Codex, Claude Code, and
Gemini CLI profiles were direct-only.

On 2026-09-03, the user approved adding only exact Hermes ACP `agentInfo`
version `0.20.5` after a controlled live-central pass with Hermes Agent 0.20.5.
The existing exact `0.21.0` entry remains. The published Ambassador 0.2.7
artifact rejects `0.20.5` in direct mode; the new entry therefore requires a
subsequent Ambassador release and does not amend what 0.2.7 supports.

On 2026-09-03, the user approved an observational installed-version probe for
every active agent profile. The probe does not decide compatibility. Production
continues to reject unreviewed MCP client and ACP identities, and provider setup
guidance continues to list the exact supported versions. The same day, the user
separately approved selecting the latest Ambassador release in public install
commands.

Later on 2026-09-03, the user clarified that the observational policy applies
to production too: known client and ACP agent names remain exact, while
reported versions must not gate registration or direct initialization. ADR
0041 supersedes the exact-version portions of this record. The commands,
arguments, delivery modes, environment policies, and ACP v1 protocol remain
fixed. ADR 0048 later changes only the fixed Claude environment policy.
ADR 0049 later changes Claude's MCP behavior to provider configuration.

On 2026-09-03, the user approved replacing the package-shipped OpenClaw
receiver with OpenClaw's native `/hooks/agent` endpoint. Ambassador keeps the
secret command, does not configure OpenClaw, and retains Hermes's existing
bearer and HMAC V2 contract. The OpenClaw webhook format and `main` agent ID are
fixed in the compiled-in profile.

Later on 2026-09-03, the user withdrew Gemini CLI from the active registry and
deferred Antigravity support. ADR 0043 supersedes the Gemini-specific profile,
qualification, and setup portions of this record.
