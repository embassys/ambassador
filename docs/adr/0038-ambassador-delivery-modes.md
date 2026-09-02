# 0038 Ambassador delivery modes

Status: accepted

Date: 2026-09-02

## Problem

The implemented gateway wakes one loopback webhook with only a message ID. A
separate connector then retrieves the body through MCP and controls a provider
through a provider-specific interface. That design no longer fits the product:

- the user wants webhook and direct agent delivery as first-class choices;
- a webhook can safely receive the complete message and accept custody;
- MCP is a request channel from an agent to the gateway, not a reverse channel
  that can wake the original chat later;
- ACP v1 provides a common client-to-agent invocation protocol;
- the current central REST service has permission and action messages but no
  conversation, reply, completion, or outcome routes; and
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

The startup command is:

```text
ambassador start --local-token-env=<environment-variable>
```

The local token continues to authenticate loopback MCP and derive the encrypted
central-credential key. Startup has no agent, delivery-mode, webhook URL,
webhook secret, central URL, or configuration-path option.

### Delivery selection during registration

Collect delivery information through "register_agent" before contacting
central. An initial call without delivery returns structured "input_required"
content asking the user whether incoming work should be sent directly to the
current agent or to a webhook.

MCP "clientInfo" can make the question friendlier and suggest a recognized
agent profile. It is not authenticated identity and cannot silently select a
profile. The follow-up tool call records the user's explicit choice.

Direct mode uses a fixed agent kind: "codex", "claude", "openclaw", or
"hermes". If "clientInfo" does not provide a recognized hint, Ambassador asks
the user to choose from that fixed list. The tool never accepts an executable,
arguments, shell command, transport, or working directory.

The direct working directory is Ambassador's canonical process directory at
registration time. It persists in the profile. A later start from a different
directory fails closed instead of changing agent scope.

Webhook mode accepts a validated URL and the name of an environment variable
containing the receiver secret. The raw secret is configured outside the model.
It never appears in MCP arguments or results.

Persist only the nonsecret delivery profile. One profile belongs to one
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

Ambassador initializes ACP, creates or safely resumes a gateway-owned session,
and submits one prompt containing fixed untrusted-input instructions plus the
complete canonical central message.

Ambassador has no interactive approval UI during background delivery. It does
not auto-approve ACP permission requests. The selected agent must rely on its
preconfigured policy and Ambassador MCP tools; any remaining permission request
is denied.

Ambassador supplies its authenticated MCP endpoint in ACP session configuration
where the agent supports it. If an agent rejects session MCP configuration, its
normal local setup must configure Ambassador MCP before direct mode is used.

The ACP session is not the MCP chat in which the user registered. Registration
does not create a reverse call path to an existing chat.

A normal terminal ACP result permits central acknowledgement. If startup fails
before prompt dispatch, a bounded retry is allowed. If prompt dispatch may have
happened and the terminal result is lost, the outcome is uncertain and the
message is not automatically submitted again.

Provider output is not sent to central because the server has no general reply
or action-result endpoint. An agent may use the existing Ambassador MCP tools
for supported permission and action operations.

### MCP catalog

MCP remains the agent-to-Ambassador business tool channel. After enrollment,
the target catalog keeps action listing, permission request and decision,
action call, and permission listing.

Remove local "poll_messages" and "ack_message" after automatic delivery owns
those operations. Do not add a reply or completion tool until central exposes a
real contract for it.

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

An opt-in local suite runs real OpenClaw and Hermes in this four-case matrix:

| Agent | Webhook | Direct |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |

The local suite uses the central fixture by default. It records versions and
safe pass/fail evidence, never prompts, messages, credentials, or provider
output. Codex and Claude can be added after their ACP profiles are implemented
and separately qualified.

Live central qualification remains a separate controlled test for email,
DPoP, REST schemas, permissions, consuming polls, and acknowledgement.

## Consequences

- Users choose delivery in the same agent conversation used for enrollment.
- The command line no longer contains delivery configuration.
- Raw webhook secrets stay outside model context.
- Webhook receivers get enough data to act without calling delivery-control
  MCP tools.
- Direct agents have one standard invocation boundary instead of custom
  provider transports.
- Ambassador now owns local agent process safety and ACP lifecycle.
- Real provider compatibility is a qualification claim, not an inference from
  a recognized profile name.
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
- ADR 0036's relevance to the initial delivery cutover.

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
- **Put agent selection on "start".** Rejected because the user chooses delivery
  during registration and the chosen profile persists.
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
on 2026-09-02.
