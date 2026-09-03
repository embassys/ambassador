# Product and architecture

Status: accepted target; implementation progress is tracked separately

## Product boundary

Embassys Ambassador is one foreground process between a local agent and the
Embassys REST service. It exposes a loopback MCP server, enrolls
one email-based central identity, and owns one local delivery profile.

The public package and command are:

```text
@embassys/ambassador
ambassador start
```

The command accepts no options and does not select an agent or delivery mode.
Ambassador resolves a fixed
agent profile from MCP `clientInfo` during registration. It asks for a delivery
choice only when that profile supports both modes, then stores the result as
nonsecret local profile data.

## System

```text
Local agent during setup and normal tool use
  |
  | loopback MCP within the local-machine trust boundary
  v
Embassys Ambassador on 127.0.0.1:8787
  |
  | Embassys REST API
  | Bearer token plus DPoP proof after verification
  v
Central permissions, actions, and messages
  |
  | consumed message batch
  v
Bounded in-memory delivery queue and ID-only journal
  |
  +--> webhook mode: complete message to an authenticated endpoint
  |
  `--> direct mode: complete message to a gateway-managed ACP v1 agent
```

MCP and ACP have different directions. MCP lets an agent call Ambassador's
business tools. In direct mode, ACP lets Ambassador start and prompt an agent.
An MCP connection cannot be used later as a reverse invocation channel.

## One process, two delivery modes

One Ambassador process owns one central identity and one persisted delivery
profile.

### Webhook

Ambassador sends the complete validated central message to the configured
webhook. The receiver authenticates the request, accepts custody with a `2xx`,
and handles any provider-specific mapping. Ambassador then acknowledges the
message to central.

The webhook contract is provider-neutral. OpenClaw or another receiver may need
a local mapping from the canonical Embassys JSON body to its native hook input.
That mapping is receiver setup, not gateway branching.

### Direct

Ambassador acts as an ACP v1 client. It launches the selected local agent,
creates or resumes a gateway-managed session as supported, and submits the
complete central message as the prompt. The direct session is not the original
chat in which the user registered.

Ambassador makes its MCP endpoint available through ACP session configuration
where the selected agent supports it. A provider that does not accept
session-level MCP configuration must have Ambassador MCP configured through
its normal setup mechanism.

Agent support is a fixed capability registry, not a name supplied by the model.
Each enabled entry has exact bounded `clientInfo` aliases, allowed modes, a
fixed executable and argument list for direct delivery, MCP setup behavior, and
qualification evidence. User input and remote content cannot add or modify an
entry.

The enabled direct profiles are OpenClaw, Hermes, Codex, Claude Code, and
Gemini CLI. Only OpenClaw and Hermes also support webhook, with direct as their
default. Codex, Claude Code, and Gemini CLI register directly without a
delivery question. Codex uses `@agentclientprotocol/codex-acp` 1.8.0, Claude Code uses
`@agentclientprotocol/claude-agent-acp` 0.73.0, and Gemini CLI 0.58.0 uses its
native `--acp` mode. Exact aliases, agent identities, environment allowlists,
and version policies remain compiled in. Unknown, ambiguous, disabled, and
incomplete profiles are unsupported.

## Guided registration

The agent first calls `register_agent` with email and optional display name.
Ambassador matches the MCP session's `clientInfo` against the capability
registry before creating any state or calling central:

- A complete direct-only profile selects direct automatically and continues.
- A complete dual-mode profile returns structured `input_required` content
  asking the user to choose direct or webhook, with direct marked as the
  default. The follow-up supplies only the mode and, for webhook, its setup
  fields.
- An unknown, ambiguous, disabled, or incomplete profile returns
  `unsupported_agent` and stops.

The model never supplies an agent kind or chooses from a profile list.
`clientInfo` is not authenticated identity, but exact matching is safe for this
purpose because it can select only a compiled-in local profile and cannot
change process details or widen capabilities. A failed direct launch does not
fall back to webhook.

Webhook setup collects the URL and the name of an environment variable that
contains the webhook secret. The raw secret never enters a prompt, tool
argument, tool result, or profile file. Ambassador does not call central
registration until the complete local delivery input validates.

## Central service relationship

The central service source is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent), and the live
service is `https://mcp.embassys.ai`. Ambassador uses its unversioned REST API.
It does not use central MCP or OAuth.

Ambassador follows current server code rather than pinning the architecture to
one commit. A client-visible server change requires a deliberate update to the
protocol, fixtures, tests, implementation, and live qualification. Ambassador
does not probe alternate contracts or keep an old client as fallback.

## Trust and custody

| Component | Owns | Does not own |
| --- | --- | --- |
| Central service | Email identities, public DPoP keys, tokens, permissions, action schemas, correlated action results, messages, acknowledgements | Local delivery or provider credentials |
| Ambassador | Loopback MCP boundary checks, encrypted central credential, internal wrapping key, DPoP proofs, delivery profile, bounded message memory, ID-only journal | Provider account credentials or durable message bodies |
| Webhook receiver | Accepted message body, receiver secret, provider-specific mapping | Central credential or DPoP key |
| Direct agent | Its own authentication, history, tools, policy, and model execution | Central credential, DPoP key, or webhook secret |

The central token and P-256 private key persist only inside one encrypted
credential file. Its wrapping material is generated internally and stored in a
separate owner-only state file. This protects against disclosure of the
credential file alone, not compromise of the owner's complete state directory.
Local MCP trusts other processes running as the owner; strict loopback, Host,
and Origin checks protect the browser and network boundary. The delivery
profile may persist the mode, recognized agent kind, webhook URL, webhook
secret environment-variable name, canonical direct working directory, and
minimum ACP session metadata. It never contains a secret or message body.
SQLite remains ID-only.

## Main flows

### Startup

1. Acquire the singleton lock.
2. Bind MCP on `127.0.0.1:8787` with strict Host and Origin checks.
3. Reject supplied local Authorization credentials.
4. Load the delivery profile and encrypted central credential if present.
5. Prepare the configured delivery target.
6. Start REST polling only when both stored records are valid.
7. Print the MCP endpoint and remain in the foreground.

### Enrollment

1. The local agent calls `register_agent`.
2. Ambassador resolves a complete capability profile and, only for a dual-mode
   profile, collects the user's direct-or-webhook choice.
3. Ambassador registers the email through central REST.
4. The user supplies the code delivered by email.
5. Ambassador generates a P-256 key and verifies with its public JWK.
6. Ambassador validates the returned key binding and timestamps.
7. It stores the token and private key before returning token-free success and
   enabling protected tools.

### Protected work

Each protected REST request carries Bearer authorization and a fresh DPoP proof
for the exact method and URL. The central action catalog supplies action names
and payload schemas. Permission requests and decisions control whether an
action call may deliver a message to another identity. The target submits one
structured success or error result for the call. Central correlates it by
`call_id` and queues an `action_response` for the original caller.

### Incoming message

1. Ambassador long-polls central.
2. Central marks selected messages delivered before returning them.
3. Ambassador validates a bounded batch, keeps bodies in memory, and journals
   only message IDs and delivery state.
4. The selected delivery target receives the complete message.
5. A webhook `2xx` or successful direct ACP completion transfers or completes
   local responsibility.
6. Ambassador acknowledges the message to central and removes its local state.

After a direct prompt may have started, an uncertain failure is not replayed
automatically. The server cannot currently redeliver a message consumed by
polling. A process crash can therefore lose an in-memory body. Server-side
retrieval or redelivery is the proper future fix.

## Non-goals

- Calling the central MCP endpoint.
- API-version probing or compatibility branches.
- A separate connector process or provider-specific gateway transport.
- Recovering the exact MCP chat used during registration.
- Passing raw secrets through the model.
- Inventing general reply, conversation, lease, outcome-lookup, activation, or
  token-reissue APIs that central does not expose.
- Persisting message bodies locally.
- Native service management or a GUI.

## Current limitations

- Central has no message retrieval or redelivery after a consuming poll.
- Action results have no per-action output schema or outcome lookup. A
  completed submission cannot be repeated to recover its response.
- Central has no token refresh or reissue route.
- Acknowledgement is not idempotent.
- Central currently disables verification-code expiry.
- Codex direct delivery and both Hermes Agent 0.20.5 delivery modes have passed
  with the live central service. Ambassador 0.2.8 includes the qualified Hermes
  ACP 0.20.5 identity. Four profile/mode cases in the seven-case real-agent
  matrix remain open.
  Hermes 0.21.0 has only its earlier contract and ACP startup probe, not the
  full real-model round trip.

Potential server improvements live in [Central follow-ups](central-follow-ups.md).
