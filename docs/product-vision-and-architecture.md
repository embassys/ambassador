# Product and architecture

Status: accepted target; implementation progress is tracked separately

## Product boundary

Embassys Ambassador is one foreground process between a local agent and the
Embassys REST service. It exposes a loopback MCP server, enrolls
one email-based central identity, and owns one local delivery profile.

The public package and commands are:

```text
@embassys/ambassador
ambassador start
ambassador start --verbose
ambassador sessions list
ambassador sessions show <session-id>
ambassador sessions show <session-id> --verbose
ambassador sessions delete <session-id>
ambassador sessions forget <session-id>
ambassador webhook-secret
ambassador clean
```

Only `start --verbose` and `sessions show <session-id> --verbose` accept an
option. No command selects an agent, delivery mode, executable, endpoint, or
credential. `webhook-secret` creates or reveals the one encrypted receiver
secret for owner-driven webhook setup. Session reads work while Ambassador is
running; session deletion, session forgetting, and `clean` require it to be
stopped. `clean` clears local enrollment, delivery, and ACP session metadata.
Ambassador resolves a fixed agent profile from MCP `clientInfo` during
registration. It asks for a delivery choice only when that profile supports
both modes, then stores the result as nonsecret local profile data.

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
  +--> validated action call: encrypted pending-action inbox until result
  |
  +--> validated action response: encrypted result inbox for later retrieval
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
and starts the selected agent through its reviewed native contract. Ambassador
then acknowledges the message to central.

Ambassador generates and encrypts the webhook secret internally. The owner
runs `ambassador webhook-secret` and copies the displayed value into the
receiver's secret store. The raw value never enters MCP, a delivery profile, or
normal logs.

Each dual-mode profile fixes its webhook format. Hermes receives the complete
canonical message through its generic bearer and HMAC-v2 route. OpenClaw
receives its native `/hooks/agent` body with the complete message inside a
fixed untrusted-input prompt. Ambassador selects the fixed `main` agent, an
isolated session, and no announcement delivery. OpenClaw authenticates the
request with the generated bearer secret and uses the central message ID as
its idempotency key. No Ambassador-specific OpenClaw plugin is installed.

### Direct

Ambassador acts as an ACP v1 client. It launches the selected local agent,
creates one persistent gateway-managed session per central message, and
submits the complete message as the prompt. The direct session is not the
original chat in which the user registered. A retry before prompt dispatch may
resume the same session; a different message never inherits that context.

All supported agents load Ambassador MCP and their other tools from normal
provider configuration. ACP session lifecycle calls carry an empty
`mcpServers` array.

Agent support is a fixed capability registry, not a name supplied by the model.
Each enabled entry has an exact bounded MCP client name, allowed modes, a fixed
executable and argument list for direct delivery, an exact ACP agent name, MCP
setup behavior, and qualification evidence. Reported MCP client and ACP agent
versions are diagnostic metadata, not compatibility gates. User input and
remote content cannot add or modify an entry.

On Windows, reviewed Node-based agents bypass their batch-file command shims.
The registry fixes the package name, bin mapping, and JavaScript entrypoint,
and Ambassador launches the validated entrypoint with its current Node
executable. The installed package version is bounded diagnostic metadata under
ADR 0041. This keeps direct launch shell-free.

The enabled direct profiles are OpenClaw, Hermes, Codex, and Claude Code. Only
OpenClaw and Hermes also support webhook, with direct as their default. Codex
and Claude Code register directly without a delivery question. Ambassador
declares the reviewed public Codex and Claude ACP adapters with unpinned npm
wildcards. A fresh or updated Ambassador installation resolves the current
adapter release; `start` does not download code. The adapters and provider
runtimes own authentication and billing choice. Native subscription login must
work without an API key, while a user-configured provider API key remains
supported. Ambassador does not initiate login or inspect, store, log, or return
provider credentials.

Every direct agent retains its provider-configured MCP and built-in tools.
When an ACP agent asks for tool permission, Ambassador holds the request open,
asks the human grantor through central email, and waits for the correlated
decision from `poll_messages`. Approval selects `allow_once` when available;
denial selects a rejection option. Ambassador does not auto-approve.
OpenClaw and Hermes provide their own fixed agent commands. Exact client and
ACP agent names, commands, arguments, modes, and environment policies remain
compiled in. Gemini CLI and Antigravity are not active profiles. Unknown,
ambiguous, disabled, and incomplete profiles are unsupported.

## Guided registration

The agent first calls `register_agent` with email and optional display name.
Ambassador matches the MCP session's `clientInfo` against the capability
registry before creating any state or calling central:

- A complete direct-only profile selects direct automatically and continues.
- A complete dual-mode profile returns structured `input_required` content
  asking the user to choose direct or webhook, with direct marked as the
  default. Selecting webhook returns the exact secret command and setup
  instruction. The final follow-up supplies only the mode and receiver URL.
- An unknown, ambiguous, disabled, or incomplete profile returns
  `unsupported_agent` and stops.

The model never supplies an agent kind or chooses from a profile list.
`clientInfo` is not authenticated identity. Its exact known client name is
safe for profile selection because it can select only a compiled-in local
profile and cannot change process details or widen capabilities. Its reported
version is bounded and observed but ignored for selection. A failed direct
launch does not fall back to webhook.

Webhook setup collects only the URL. Ambassador does not call central
registration until that URL validates and its encrypted webhook secret exists.
The raw secret never enters a prompt, tool argument, tool result, or profile
file.

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
| Ambassador | Loopback MCP and private-control boundary checks, encrypted central credential, encrypted webhook and local-control secrets, separate internal wrapping keys, DPoP proofs, delivery profile, bounded message memory, ID-only journal, encrypted unanswered action calls, encrypted received action results | Provider account credentials or durable copies of unrelated message bodies |
| Webhook receiver | Accepted message body, receiver secret, provider-specific mapping | Central credential or DPoP key |
| Direct agent | Its own authentication, history, tools, policy, and model execution | Central credential, DPoP key, or webhook secret |

The central token and P-256 private key persist only inside one encrypted
credential file. The webhook and private-control secrets persist in their own
encrypted files. Each encrypted value has independently generated wrapping
material in a separate owner-only state file. This protects against disclosure
of one encrypted value without its key, not compromise of the owner's complete
state directory.
Local MCP trusts other processes running as the owner; strict loopback, Host,
and Origin checks protect the browser and network boundary. The delivery
profile may persist the mode, recognized agent kind, webhook URL, and canonical
direct working directory. An owner-only SQLite database holds bounded ACP
session IDs, central correlation IDs, lifecycle state, and timestamps. It never
contains a secret, message body, prompt, tool data, or provider output. The
notification journal remains ID-only. Two separate SQLite inboxes store only
encrypted, validated unanswered action calls and received action results. Both
are keyed to the enrolled DPoP identity.

## Main flows

### Startup

1. Acquire the singleton lock.
2. Open the ID-only journal, create or load the encrypted internal control
   secret, and load the encrypted central credential and delivery profile when
   present.
3. Bind MCP on `127.0.0.1:8787` with strict Host and Origin checks and a
   separately authenticated non-MCP route for live session reads.
4. Reject supplied Authorization credentials on `/mcp`.
5. For an enrolled identity, open the encrypted action-call and action-result
   inboxes and ACP session metadata.
6. For webhook mode, load the separately encrypted webhook secret.
7. Prepare the configured delivery target.
8. Start REST polling only when the required stored records are valid.
9. Print the MCP endpoint, fixed setup commands for all supported agents, the
   registration prompt, and remain in the foreground.

A local agent or webhook delivery failure pauses incoming delivery and prints
one bounded repair message without taking down the MCP server. Central,
credential, state, and listener failures remain fatal. Restarting Ambassador
after repairing the local target resumes polling for new messages; it cannot
recover a message already consumed by central.

Direct agents may use their normally configured tools while handling the fixed
Embassys delivery prompt. Ambassador imposes no safe mode, tool disablement,
or provider bypass. ACP tool execution waits for the human email decision
defined by ADR 0055. A
missing tool leaves an action available through the encrypted pending-action
inbox.

### Session inspection

`sessions list` and `sessions show` work whether Ambassador is stopped or
running. While it runs, the CLI calls a fixed private route on the same
loopback listener with an internally generated encrypted secret. This route is
not an MCP tool and is never disclosed to the agent. The foreground process
serializes provider history loading with direct delivery and session cleanup.

When Ambassador is stopped, read commands acquire the singleton lock and open
the local session store directly. `sessions delete` and `sessions forget`
always require that stopped path because they remove provider or local state.

### Local reset

1. The owner stops the foreground Ambassador process.
2. `ambassador clean` acquires the singleton process lock. It fails without
   changing state if another process owns the lock or if the lock cannot be
   validated.
3. It removes the credential pair, webhook-secret pair, local-control-secret
   pair, delivery profile, encrypted action-call and action-result inboxes, ACP
   session metadata, notification journal, and any interrupted state writes.
4. It retains the empty owner-only state directory and process lock for safe
   coordination.
5. The next `ambassador start` exposes the bootstrap enrollment tools.

The command does not call central, unregister the old email address, remove
messages from Mailosaur, or change provider configuration. A repeated local
test therefore needs a new disposable email unless central state is cleared
separately.

### Enrollment

1. The local agent calls `register_agent`.
2. Ambassador resolves a complete capability profile and, only for a dual-mode
   profile, collects the user's direct-or-webhook choice.
3. Ambassador registers the email through central REST.
4. The user supplies the code delivered by email.
5. Ambassador generates a P-256 key and verifies with its public JWK.
6. Ambassador validates the returned key binding and timestamps.
7. It stores the token and private key before returning token-free success and
   enabling protected tools. The complete MCP tool catalog is stable across
   this transition: protected calls return `not_enrolled` before verification,
   and enrollment calls return `already_enrolled` afterwards.

### Protected work

Each protected REST request carries Bearer authorization and a fresh DPoP proof
for the exact method and URL. The central action catalog supplies action names
and payload schemas. Permission requests and decisions control whether an
action call may deliver a message to another identity. The target submits one
structured success or error result for the call. Central correlates it by
`call_id` and queues an `action_response` for the original caller.

Embassys permission decisions belong only to the human email flow. Central
emails the grantor's owner, does not wake the grantor's local agent, and queues
the resulting `permission_outcome` to the requester. Ambassador exposes no
permission-decision tool and does not project pending permissions into
`get_inbox`. `get_my_permissions` remains available for status and audit.

After the human decides, central sends the requester a `permission_outcome`.
For a grant, Ambassador's fixed delivery prompt tells the receiving agent to
continue the approved action once, using the outcome's `grantor_email` as the
target and its `action_type`; outcome metadata is not passed to `call_action`.

Provider-tool approval inside a direct ACP turn is separate. Ambassador calls
`get_human_input` with the triggering message ID, so central emails the local
agent's own owner. The owner chooses allow once or deny. Ambassador waits for
the correlated `human_input_response` on `poll_messages?timeout=0`, answers the
open ACP request, and keeps the control response out of provider prompts.

`get_inbox` includes action calls already delivered to this
identity that still need a result. Ambassador encrypts the validated call ID,
sender ID, action type, payload, and creation time before local delivery and
central acknowledgement. A successful `submit_action_result` removes that call
and retires its ACP session.

The final inbox item is an unread `action_response` received for an action this
identity requested. Ambassador encrypts the call ID, sender ID, action type,
status, structured result, and creation time before local delivery and central
acknowledgement. Results survive restarts until `get_inbox` returns them once.
This lets a foreground agent answer "have we heard back?" without access to
the background ACP session. None of these inbox views requires a new central
route.

### Incoming message

1. Ambassador long-polls central.
2. Central marks selected messages delivered before returning them.
3. Ambassador validates a bounded batch and journals only message IDs and
   delivery state. It first writes validated action calls or action responses
   to their separate encrypted inboxes.
4. The selected delivery target receives the complete message. If it needs
   unavailable user input, it leaves the action call pending.
5. A webhook `2xx` or successful direct ACP completion transfers or completes
   local responsibility.
6. Ambassador acknowledges the message to central and removes its local state.

Direct session metadata remains available after delivery. Non-action sessions
retire after a normal turn. Action-call sessions retire after the matching
central result succeeds. Ambassador attempts provider deletion after 30 days
and otherwise forgets metadata when deletion is unsupported.

After a direct prompt may have started, an uncertain failure is not replayed
automatically. The server cannot currently redeliver a message consumed by
polling. A process crash can therefore lose an in-memory body. Server-side
retrieval or redelivery is the proper future fix.

## Non-goals

- Calling the central MCP endpoint.
- API-version probing or compatibility branches.
- A separate connector process or user-supplied provider transport.
- Recovering the exact MCP chat used during registration.
- Passing raw secrets through the model.
- Inventing general reply, conversation, lease, central outcome-lookup,
  activation, or token-reissue APIs that central does not expose.
- Persisting central message bodies locally except for encrypted validated
  unanswered action calls and received action results.
- Native service management or a GUI.

## Current limitations

- Central has no message retrieval or redelivery after a consuming poll.
- Action results have no per-action output schema or outcome lookup. A
  completed submission cannot be repeated to recover its response. A rare
  local deletion failure after central success can therefore leave a stale
  pending-action row that Ambassador cannot reconcile automatically.
- Central has no token refresh or reissue route.
- Acknowledgement is not idempotent.
- Central currently disables verification-code expiry.
- Windows is a qualification candidate under ADR 0040. Native state,
  packed-package, and mock delivery qualification pass; individual agent and
  mode claims still require exact real-agent Windows evidence.
- Ambassador releases through 0.2.8 use exact provider-version allowlists.
  Published Ambassador 0.2.9 implements ADR 0041's name-based,
  version-observational policy; earlier artifacts do not gain that behavior
  retroactively.
- ADR 0050's common persistent-session policy and current public Codex and
  Claude adapters passed one clean combined packed-artifact qualification with
  the live central service. Both delivery modes for Hermes Agent 0.20.5 and
  OpenClaw 2026.8.2 passed under the earlier delivery policy and still need an
  ADR 0050 live repeat. Gemini CLI has been removed and Antigravity is deferred
  under ADR 0043. Hermes 0.21.0 has only its earlier contract and ACP startup
  probe, not the full real-model round trip.

Potential server improvements live in [Central follow-ups](central-follow-ups.md).
