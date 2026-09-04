# Ambassador protocol

Status: implemented; future work is listed in
[Current work](implementation-plan.md)

This document defines the current target without a compatibility or migration
promise.

## Startup

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
option. `webhook-secret` creates one encrypted 48-character lowercase
hexadecimal secret when absent and writes the stable value to standard output
for the owner to copy into a receiver. It does not take the singleton process
lock. `start` has no local token, agent selector, delivery-mode selector,
endpoint option, configuration path, webhook secret option, or `--acp-agent`
option.

`clean` acquires the singleton process lock and refuses to continue if
Ambassador is running or the lock artifact is invalid. While it owns the lock,
it removes every entry from the private Ambassador state directory except the
lock database and its active SQLite sidecars. This includes the encrypted
central credential and key, encrypted webhook secret and key, encrypted local
control secret and key, delivery profile, ACP session metadata, notification
journal, interrupted temporary writes, and later local state artifacts.
Symbolic links inside the state directory are removed as links; the command
does not follow them.

A successful command writes exactly:

```text
Ambassador local state cleared
```

The operation is idempotent. It retains the empty state directory and lock for
coordination, then the next `start` presents the bootstrap enrollment catalog.
It never calls central, unregisters an email, removes provider configuration,
or handles provider credentials. The explicit `clean` command is the owner's
authorization for this local deletion; there is no force option or interactive
prompt.

The process acquires its singleton lock before reading credentials, binding a
listener, calling central, starting an agent, or sending a webhook. It binds
`127.0.0.1:8787` and prints the ready endpoint followed by fixed MCP setup
commands for every supported agent. The output ends with the registration
prompt and a reminder to keep Ambassador running. Its first line is:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

`SIGINT` and `SIGTERM` stop new work, cancel central polling, cancel or close
the active delivery target within its deadline, close local state, and release
the lock.

When Ambassador is running, `sessions list` and `sessions show` use its private
authenticated loopback control route. The foreground process serializes
`show` with delivery and retention cleanup, starts the fixed configured agent,
uses ACP `session/load`, and prints bounded provider history. `--verbose` also
includes bounded tool events. When Ambassador is stopped, both read commands
retain the same behavior under the singleton lock. `sessions delete` and
`sessions forget` always require Ambassador to be stopped. Deletion requires
the agent to advertise `session/delete` and forgets metadata only after
provider success; forgetting removes only the local record.

Startup failures use bounded operator messages. They distinguish an occupied
MCP port, invalid or unavailable local state, an unavailable agent or bundled
adapter, ACP initialization failure, uncertain direct delivery, and a generic
webhook or relay failure. They never print raw provider output, central bodies,
credentials, or unbounded exception text.

Verbose startup adds bounded timestamped events for ACP lifecycle and
permission choices, MCP tool calls, central REST requests, and delivery state.
It may include personally identifying request and result data. It always
redacts authorization, DPoP material, nonces, tokens, verification codes,
private keys, cookies, and webhook secrets. Verbose output is console-only.
ACP available-command catalogs and their descriptions are omitted; the log
records only the session ID and command count for that update.

## Local MCP

Every local MCP request uses Streamable HTTP at `/mcp` without bearer
authentication. Ambassador requires `Host: 127.0.0.1:8787`. A present
`Origin` must be exactly `http://127.0.0.1:8787`. A supplied `Authorization`
header is rejected. Host and Origin checks happen before body parsing.

The same listener has a non-MCP private control route used only by Ambassador's
CLI for live session reads. It requires exact loopback Host, rejects every
Origin, requires the generated encrypted internal bearer secret, and accepts
only exact bounded `sessions.list` and `sessions.show` operations. The route,
secret, and operations are never exposed in the MCP catalog or configuration.

The local MCP boundary trusts processes running as the owner on the same
machine. Host and Origin validation protect against DNS rebinding and ordinary
cross-origin browser requests, not a malicious same-user process.

The boundary keeps these limits:

| Boundary | Limit |
| --- | --- |
| Request headers | 16 KiB |
| Local MCP request body | 1 MiB |
| Private control request body | 4 KiB |
| Local or upstream response body | 4 MiB |
| Active MCP sessions | 32 |
| Concurrent tool calls | 8 |
| Serialized structured tool result | 512 KiB |

JSON-RPC batches and redirects are rejected. Errors do not reflect request
bodies, remote bodies, URLs, headers, or credentials. Expected tool failures
use a bounded human-readable MCP error message and structured `code` and
`source` fields. Verbose mode also prints the original bounded error name,
message, error code, and cause chain. This lets an operator distinguish local
profile, central enrollment, protected REST, and delivery failures without
exposing credentials.

MCP initialization `clientInfo` is retained as bounded session metadata. Its
name is matched exactly against a compiled-in capability registry; its version
is diagnostic and does not enable or reject a profile. `clientInfo` is not
authenticated identity, so it cannot authorize central work or supply process
configuration. The name may only select a complete fixed local profile whose
delivery modes, command, arguments, ACP agent name, and MCP behavior have been
reviewed and tested.

The MCP initialization response tells the client that Ambassador handles
Embassys registration and agent-network operations. It directs the client to
call `register_agent` when the user says "register me" or asks to connect to
Embassys or Ambassador. It also says that registration needs an email, not a
website or browser flow, and points the emailed-code step to `verify_email`.

An unknown, ambiguous, disabled, or incomplete match is unsupported. The model
cannot supply an agent kind, executable, arguments, adapter, or fallback
profile.

## Tool catalog

Before enrollment, expose exactly:

- `register_agent`
- `verify_email`
- `resend_verification`

After a credential is durably stored, expose exactly these agent-facing tools:

- `list_action_types`
- `request_permission`
- `get_inbox`
- `call_action`
- `submit_action_result`
- `get_my_permissions`

Incoming delivery and central acknowledgement belong to Ambassador. The target
catalog has no local `poll_messages` or `ack_message` tools. It also has no
general reply, conversation, outcome-lookup, activation, or token-reissue tool
because central has no corresponding REST operation.

Ambassador owns the MCP tool schemas. It does not fetch or mirror a central MCP
catalog. `list_action_types` returns central action definitions as data; those
definitions do not become additional local tools.

`get_inbox` is the single agent-facing view of work and unread results. It
accepts no arguments and returns:

- encrypted local action calls that still need a result; and
- encrypted local action results that have not appeared in a previous inbox
  response.

Each action-call item includes the tool and fields needed for its response.
Action calls remain until `submit_action_result` succeeds. Ambassador removes
received action results after returning them through `get_inbox`, so the
default view contains unread results only. The tool adds no central route,
does not poll central on demand, and is not a general message inbox.

Permission decisions do not appear in `get_inbox`. Central emails the
grantor's human, queues no request to the grantor's agent, and later delivers a
`permission_outcome` to the requester. `get_my_permissions` remains the
agent-facing audit and status view.

Central action definitions currently describe request payloads through
`input_schema` but do not publish a result schema. Ambassador therefore tells
the agent to submit a structured success or error object, but it cannot state
or validate action-specific result fields. A central `result_schema` is tracked
as server work. Ambassador does not duplicate the central action catalog in a
local result-schema registry.

Reject any argument named `token`, `jwt`, `access_token`, `authorization`, `private_key`,
`secret`, `proof`, or `dpop` before dispatch. Reject any upstream result
containing those credential fields or stored token bytes.

## Guided registration

### Profile resolution and initial call

`register_agent` accepts:

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name"
}
```

Before writing state or contacting central, Ambassador resolves the current MCP
session's exact client name to one enabled capability profile. OpenClaw and
Hermes support direct and webhook delivery. Codex and Claude Code are
direct-only. All use their fixed compiled-in contracts. The reported MCP
client version does not gate resolution.

Profile behavior is capability-driven:

| Matched profile | Registration behavior |
| Complete direct-only | Select direct and continue without a delivery question |
| Complete direct and webhook | Return `input_required`; direct is the default |
| Unknown, ambiguous, disabled, or incomplete | Return `unsupported_agent`; write no state and make no central request |

Codex and Claude Code follow the direct-only row. For a dual-mode
OpenClaw or Hermes profile, an initial call without `delivery` returns structured
content equivalent to:

```json
{
  "status": "input_required",
  "prompt": "How should incoming requests reach this agent?",
  "required": ["delivery"],
  "default": "direct",
  "choices": [
    {"value": "direct", "label": "Send directly to this agent"},
    {"value": "webhook", "label": "Send to a webhook"}
  ]
}
```

The labels should name the matched agent, such as "Send directly to this
OpenClaw agent". The agent presents the question to the user and makes a
follow-up call. MCP elicitation may improve the experience where available, but
correctness cannot depend on it.

An unsupported result is structured content equivalent to:

```json
{
  "status": "unsupported_agent",
  "message": "This MCP client is not supported by this Ambassador version."
}
```

The result may list enabled profile names but must not echo raw `clientInfo`.
Supplying `delivery` cannot bypass profile resolution or make an unsupported
client valid.

### Direct follow-up

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name",
  "delivery": {
    "mode": "direct"
  }
}
```

The agent kind always comes from the matched capability entry. `register_agent`
has no `agent` field. Direct-only profiles do not need this follow-up; if a
caller sends it anyway, it may be accepted only when it agrees with the
resolved profile. User input never supplies an executable, argument list,
shell fragment, adapter, transport, or path.

### Webhook follow-up

Selecting webhook without a URL, or before the local secret exists, returns
structured content equivalent to:

```json
{
  "status": "input_required",
  "prompt": "Run `ambassador webhook-secret`, configure the displayed secret in this agent, then retry with the receiver URL.",
  "required": ["delivery.url"],
  "command": "ambassador webhook-secret"
}
```

The label names the matched agent. The owner runs the command in a terminal
and copies its output into that receiver's credential store. The agent never
receives the value. For OpenClaw, the result tells the owner to set the value as
`hooks.token`, enable native hooks for agent `main`, restart OpenClaw, and use
its `/hooks/agent` URL. It does not install a plugin or change OpenClaw
configuration. The final call is:

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name",
  "delivery": {
    "mode": "webhook",
    "url": "https://agent.example.test/embassys"
  }
}
```

Ambassador refuses central registration until its separately encrypted webhook
secret exists. Neither the secret nor a selector for it is accepted through
MCP. Repeating `ambassador webhook-secret` reveals the existing value and does
not rotate it.

Webhook URLs may use HTTPS. Plain HTTP is accepted only for a literal loopback
host. Credentials, fragments, control characters, unsupported schemes, and
redirect-based target changes are rejected.

Webhook input is accepted only for a matched profile whose registry entry
enables webhook delivery. There is no generic webhook path for an unknown
client and no automatic webhook fallback after direct failure.

Ambassador validates and atomically stores the nonsecret delivery profile
before it sends `POST /api/register_agent`. A conflicting stored profile or
partially valid state fails closed. Development reset removes the complete
state; there is no profile migration or compatibility reader.

The central registration body remains:

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name"
}
```

The successful response contains `agent_id`, `email`, and `message`.

### Resend and verification

`resend_verification` sends:

```json
{"email":"agent@example.test"}
```

`verify_email` accepts:

```json
{
  "email": "agent@example.test",
  "code": "123456"
}
```

Ambassador serializes verification attempts, generates one P-256 key pair, and
sends the email, code, and public JWK to `POST /api/verify_email`. It
intercepts the returned token before generic result serialization and checks:

- bounded compact-JWT structure;
- string `sub` and `email`;
- numeric `iat` and `exp`, with `exp` in the future and later than `iat`;
- token `cnf.jkt`, response `jkt`, and generated-key thumbprint agreement;
  and
- response identity agreement with the requested email.

The server uses an HS256 signature that the client cannot verify. Ambassador
does not invent issuer, audience, token type, token ID, or lifetime requirements
that the server does not expose.

The token and PKCS#8 private key are stored as one atomic encrypted credential.
Only after persistence succeeds does Ambassador enable protected tools and
automatic delivery. The local result contains identity and token-free success,
never the token, JWK, thumbprint, or key.

## Delivery profile

The profile contains only the minimum nonsecret fields:

| Mode | Fields |
| --- | --- |
| `webhook` | mode, registry-derived fixed agent kind, canonical URL |
| `direct` | mode, registry-derived fixed agent kind, canonical startup working directory, minimum opaque ACP session metadata when safe and supported |

The profile uses the same protected application-state directory as the central
credential and journal. It is written atomically with restrictive ownership and
permissions. It never contains secret values, message bodies, prompts, provider
output, provider credentials, or executable input.

One profile belongs to one central identity. The stored agent kind and mode
must still correspond to a complete enabled registry entry at startup. Runtime
mode switching is not part of this development cutover.

## Central REST and DPoP

The production origin is fixed:

```text
https://mcp.embassys.ai
```

Production code has no central MCP URL or API-version selector. Tests may
inject a local REST origin through an internal seam. That seam is not user
configuration, fallback, or discovery.

Every protected request sends:

```http
Authorization: Bearer <central-token>
DPoP: <proof-jwt>
```

`Authorization: DPoP` is not supported. Each proof is signed with ES256 by
the credential's P-256 key. Its header contains `typ: dpop+jwt`,
`alg: ES256`, and the public JWK. Its payload contains a unique `jti`, exact
uppercase `htm`, exact request URL in `htu`, current `iat`, and
`base64url(sha256(access_token))` in `ath`.

If a `401` supplies one valid `DPoP-Nonce`, cache it for the REST origin and
repeat the same operation once with a fresh proof and the nonce claim. The
first request does not include a nonce proactively. Any other authentication
failure does not trigger registration, token replacement, or a bearer-only
retry.

The current protected routes are:

| Operation | Method and path | Input |
| --- | --- | --- |
| List actions | `GET /api/list_action_types` | none |
| Request permission | `POST /api/request_permission` | `target_email`, `message_id`, or both when consistent; exactly one of `action_type` / `permission_type`; optional `decision_options`, `reason`, and `scope` |
| Ask the local agent's owner | `POST /api/get_human_input` | internal only; fixed `permission_type`, bounded question, `buttons`, allow-once and deny options, triggering `message_id` |
| Call action | `POST /api/call_action` | `target_email`, `action_type`, `payload` |
| Submit action result | `POST /api/submit_action_result` | `call_id`, `result`, `status` |
| List permissions | `GET /api/get_my_permissions` | none |
| Receive messages | `GET /api/poll_messages?timeout=<0..60>` | internal only |
| Acknowledge message | `POST /api/ack_message` | internal only; `message_id` |

The permission-request response always includes `permission_id`, `status`, and
`message`. The current deployment may also include `already_granted` and
`decision`; Ambassador validates and returns those fields when present.
When `message_id` is supplied, central derives the grantor from that message
and gives it precedence over `target_email`; a supplied email must agree.
`decision_options` is `accept_deny` by default or `once_always` when the human
should choose between one use and a standing grant. `reason` is bounded to 500
characters and appears in the email. For a new request, central emails the
grantor a read-only confirmation page whose form submits the decision. It
queues no `permission_request` message to the grantor's agent. After the human
decides, central queues a
`permission_outcome` to the requester. A granted outcome tells the receiving
agent to continue once through `call_action`, mapping `grantor_email` to
`target_email` and using the outcome's action type. Ambassador does not handle
the email token or call central's unauthenticated decision endpoint during
normal use.

An `allow_once` grant permits one action call. `allow_always` and the simpler
`accept` decision are standing grants. If central returns
`already_granted: true`, the requester can proceed immediately and no new
approval email was sent.

`call_action` delivers a request after central confirms permission. It does
not execute the action. Its `call_id` correlates the one permitted result.

Only the target of the original call may invoke `submit_action_result`.
`status` is `success` or `error`, and `result` is a structured object. Central
maps those values to the action-call states `completed` or `failed`, then
queues an `action_response` for the original caller with the same `call_id`,
action type, submitted status, and result. A later submission for a finished
call returns `409`. This is an action result, not a general chat reply.

Ambassador does not retry a result submission after an uncertain response.
The endpoint has no idempotency key or outcome lookup, and a repeated accepted
submission returns `409` without recovering the first response's message ID.

## Incoming queue

Ambassador holds one 30-second central long poll. The response has a
`messages` array. Current central messages contain `id`,
`sender_agent_id`, optional `action_type_id`, `payload`, and
`created_at`. New permission requests do not appear in this queue. Current
delivered payloads include `permission_outcome`, `human_input_response`,
`action_call`, and `action_response`; Ambassador still validates any bounded
payload object before local delivery. The human-input response is internal ACP
control and is not sent to the provider as a business prompt.

Central marks selected rows delivered in the same database statement that
returns them. Before accepting a batch, Ambassador enforces its response,
nesting, structural-token, batch-count, and normalized-message limits.
Conflicting duplicate IDs reject the batch.

Message bodies remain in a bounded in-memory delivery queue. The notification
journal stores present IDs and delivery state only. Two bounded persistence
exceptions use separate encrypted inboxes. Ambassador stores validated
`action_call` fields so a user can answer later, and validated
`action_response` fields so a foreground agent can retrieve a returned result.
It writes either record before local delivery or central acknowledgement.
Other message types are not persisted. Polling pauses while the queue contains
work. An ID-less message may be delivered once but cannot be acknowledged.

## Webhook delivery

Each enabled webhook profile fixes one reviewed request format. User or model
input cannot select or change it.

Hermes receives the complete normalized central message as the JSON request
body:

```http
POST <configured-url>
Authorization: Bearer <webhook-secret>
Idempotency-Key: <message-id>
X-Request-ID: <message-id>
X-Webhook-Timestamp: <current-Unix-seconds>
X-Webhook-Signature-V2: <hex-HMAC-SHA256>
Content-Type: application/json
```

The HMAC uses the webhook secret and covers the ASCII timestamp, one `.` byte,
and the exact body bytes. The receiver validates the bearer, signature,
timestamp window, body bounds, and idempotency key before accepting custody.

OpenClaw receives a native agent-hook request:

```http
POST <configured-url>
Authorization: Bearer <webhook-secret>
Idempotency-Key: <message-id>
Content-Type: application/json
```

```json
{
  "message": "<fixed untrusted-input instructions and complete normalized central message JSON>",
  "name": "Embassys Ambassador",
  "agentId": "main",
  "sessionMode": "isolated",
  "deliver": false
}
```

Ambassador does not send HMAC-v2, timestamp, or request-ID headers to OpenClaw.
OpenClaw's native hook authenticates the bearer, applies its agent allowlist,
uses the idempotency key for bounded replay handling, safety-wraps external
content, and admits a normal model turn. The native request body may not exceed
256 KiB. The Hermes canonical body retains its 512 KiB limit.

A `2xx` means the receiver accepted responsibility for the complete message.
Ambassador records that transfer before acknowledging central. A non-`2xx`
or pre-acceptance transport failure may retry within the fixed delivery budget
using the same idempotency key. Hermes receives a fresh timestamp and signature
on each attempt. Because a timeout can be uncertain, receivers must deduplicate
by message ID.

Hermes adapts the canonical body through its native generic webhook route.
OpenClaw normally uses `/hooks/agent` and returns `200` with a run ID after
session and global placement admission. That response does not mean the model
finished. For both receivers, a `2xx` proves custody or admission only. Model
execution, MCP invocation, and the final correlated response remain separate
qualification observations.

## Direct ACP delivery

Direct mode uses ACP v1 through exact `@agentclientprotocol/sdk` 1.4.0.
Ambassador is the ACP client and starts a fixed command for the selected agent
profile without a shell. User or message input cannot change the executable,
arguments, environment policy, transport, or working directory. The working
directory is the canonical process directory captured during registration. A
later start from a different directory fails closed instead of silently moving
the agent's scope.

For a package-owned Node adapter, the profile fixes its package name, bin name,
and JavaScript entrypoint. Ambassador resolves that declared production
dependency from its own installation, validates the package identity, bin
mapping, bounded version metadata, and contained entrypoint, then launches it
with the current Node executable. It never downloads an adapter at runtime or
uses a `PATH` shadow. External native agent commands retain their fixed
invocation. On Windows, the same no-shell validation also applies to a reviewed
external Node package such as OpenClaw.

Adapter processes retain normal provider authentication and configuration.
Native subscription login works without an API key; a user-configured provider
API key remains available when the provider supports it.

The enabled profiles and fixed contracts are:

| Profile | MCP client name | Direct invocation | ACP agent name | MCP setup |
| --- | --- | --- | --- | --- |
| OpenClaw | `openclaw-bundle-mcp` | `openclaw acp` | `openclaw-acp` | provider configuration |
| Hermes | `mcp` | `hermes-acp` | `hermes-agent` | provider configuration |
| Codex | `codex-mcp-client` | current package-owned `codex-acp` | `@agentclientprotocol/codex-acp` | provider configuration |
| Claude Code | `claude-code` | current package-owned `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` | provider configuration |

A profile is enabled only after its exact client and agent names, invocation,
MCP configuration behavior, and qualification cases are committed. Adapter
downloads at runtime are forbidden. Ambassador declares the reviewed Codex and
Claude adapters with unpinned npm wildcards. A fresh or updated Ambassador
installation resolves the current releases; the repository lockfile records
the versions tested by CI. OpenClaw and Hermes provide their own agent
commands. Reported MCP client and ACP agent versions are not allowlists. Gemini
CLI and Antigravity are unsupported client names.

Every direct agent loads Ambassador and other tools from normal provider
configuration. Session lifecycle requests send `mcpServers: []`. Ambassador
does not disable built-in tools, request a provider bypass, or impose safe or
restricted mode. Authentication and billing remain with the agent and its
provider.

The repository qualification probe runs each profile's fixed version command,
records a bounded semantic version or `unavailable`, and continues to that
profile's delivery cases. Production uses the same observational policy for
reported versions. It still requires ACP v1 and the exact `agentInfo.name`
shown in the table. An incompatible release fails through bounded startup,
initialization, session, or delivery handling.

Ambassador initializes the agent and opens one persistent gateway-managed
session for each central message. It requires `session/resume` or
`session/load`. Before prompt dispatch, a bounded retry of the same central
message may resume its stored session. A new central message always receives a
new session.

Ambassador has no interactive approval UI during background delivery. For an
ACP permission request, it submits one human approval request correlated by the
triggering central `message_id` to `POST /api/get_human_input`. Central always
emails the authenticated agent's own owner. Ambassador repeatedly calls
`poll_messages?timeout=0` until the matching `human_input_response` arrives; it
does not use `get_human_input_status`.
Normal prompt and outer delivery deadlines pause during that human wait.
Approval selects `allow_once` when offered, then another advertised positive
option; denial selects an advertised rejection option. A missing option of the
required polarity cancels the ACP request.

Messages consumed by the approval poll remain in a bounded in-memory queue for
the normal relay. The correlated response is handled internally and is not sent
to the provider as another prompt. Unrelated messages keep their arrival order.

The local MCP server advertises the same complete tool catalog before and
after enrollment. Protected tools return `not_enrolled` until verification;
bootstrap registration tools return `already_enrolled` afterwards. Correctness
does not depend on an MCP client implementing tool-list-change notifications.

For each central message, Ambassador sends one ACP prompt containing:

1. a fixed, trusted Embassys instruction envelope that identifies the
   following remote fields as data;
2. the complete canonical JSON message; and
3. direction to use the configured Ambassador MCP tools when a permission or
   action operation requires them.

For an `action_call`, the agent uses `submit_action_result` with the supplied
`call_id` when it can provide a structured success or definitive error without
guessing. If the result needs user input that is not available in that turn,
the agent leaves the call pending. The user can later ask for pending actions,
supply the answer, and have an agent submit the correlated result through MCP.
Ambassador does not reinterpret free-form provider output as an action result
and still discards that output after bounded processing.

A normal terminal ACP result completes local handling and permits central
acknowledgement. Startup failure before prompt submission may be retried within
the delivery budget. Once prompt submission may have occurred, a crash,
timeout, malformed stream, lost terminal result, or failed cleanup is
uncertain. Ambassador does not automatically submit that message again.

Direct mode does not resume the MCP chat that performed registration. An
owner-only SQLite database stores bounded provider session IDs, fixed agent
kind, working directory, central message ID, action `call_id`, lifecycle state,
and timestamps. It stores no prompt, message body, provider output, MCP data,
or credential.

Non-action sessions retire after a normal ACP turn. An action-call session
stays active while its encrypted pending-action row remains and retires only
after central accepts the matching `submit_action_result`. After 30 days,
Ambassador calls `session/delete` when advertised and removes the local record
after success. When deletion is unsupported, it forgets the local record. A
transient deletion failure retains the record for another cleanup attempt.

## Central acknowledgement

After webhook custody transfer or successful direct completion, Ambassador
sends one protected `POST /api/ack_message`. Only a response with the matching
`message_id` and `status: "acked"` removes the journal row.

The current server does not make acknowledgement idempotent. Ambassador does
not blindly replay an acknowledgement after an uncertain response. It reports
the bounded failure without redelivering completed local work.

A process crash clears delivery bodies from memory. Startup can remove stale
pre-delivery journal rows whose bodies cannot be recovered. The separate
encrypted pending-action record survives, but Ambassador does not replay it to
the delivery target; it is available through `get_inbox` for a later
user-driven answer. A captured action response remains unread in `get_inbox`
until that tool returns it once. Central has no delivered-message retrieval, so a crash
between central's consuming poll and local capture can still lose any message.
Other non-action messages can also be lost or left unacknowledged. This remains
a declared development limitation.

## Deadlines and data boundary

| Operation | Deadline |
| --- | --- |
| Central REST call | 30 seconds |
| Central message long poll | 40 seconds for a 30-second server hold |
| Local MCP request | 35 seconds |
| Webhook delivery | 10 seconds |
| ACP process initialization | 15 seconds |
| ACP session creation or resume | 15 seconds |
| ACP prompt | 15 minutes |
| ACP cancellation grace | 10 seconds |
| ACP child cleanup | 5 seconds |

One 15-minute-and-30-second outer ACP delivery budget includes all ACP stages.
A stage never extends it. Tests may inject shorter positive deadlines through
internal seams. No deadline is a CLI option.

Never write message bodies, permission details, MCP arguments or results,
registration emails, verification codes, tokens, private keys, proofs, nonces,
webhook secrets, prompts, or provider output to SQLite, profiles, normal logs,
metrics, temporary files, crash artifacts, or support bundles. Verbose console
output may contain bounded message, MCP, provider-history, and REST data after
mandatory credential redaction; it is never persisted. ADR 0046 defines the
bounded encrypted record for each unanswered action call. ADR 0051 defines a
separate bounded encrypted record for each received action result. The ACP
session database contains only bounded identifiers, lifecycle state, and
timestamps. The only raw
webhook-secret output is the explicit owner-invoked `webhook-secret` command.

The encrypted central credential contains only the central token and DPoP
private key plus minimum format metadata. The webhook secret uses a different
encrypted file, wrapping key, and authenticated-data scope. Ambassador
generates both wrapping keys internally. All four files have the same strict
ownership, link, permission, and atomic-write checks. A value without its
matching key fails closed; there is no migration. The delivery profile is
nonsecret. The notification journal remains ID-only. The pending-action
encryption key is derived with domain separation from the loaded DPoP private
key, so the inbox is bound to the enrolled identity without another
user-managed secret. Its SQLite lookup key and authenticated ciphertext reveal
neither the call ID nor the action payload. The inbox is bounded to 256 records
and 480 KiB of ciphertext. The action-result inbox uses separate domain labels
with the same identity binding. Its lookup key and authenticated ciphertext
reveal neither the call ID nor the returned data. It is bounded to 256 records
and 400 KiB of ciphertext.

## Acceptance cases

The cutover must prove at least:

- the new package, binary, startup contract, and rejection of old interfaces;
- exact capability-registry matching, direct-only automatic selection, and
  dual-mode registration with direct as the default;
- safe `clientInfo` handling, rejection of unknown or incomplete profiles, and
  no model-supplied agent or process configuration;
- no raw secret in MCP, profile data, normal output, logs, or process
  arguments; the explicit secret command is the only display path;
- complete-message webhook delivery, authentication, deduplication, retry, and
  acknowledgement ordering;
- ACP v1 initialize, persistent session create/resume/load/delete, provider MCP
  setup, positive permission selection, prompt, terminal success, failure,
  cancellation, crash, and uncertainty handling;
- deterministic CI coverage with a mock webhook receiver and mock ACP agent;
- opt-in local coverage for direct delivery on all four profiles and webhook
  delivery on OpenClaw and Hermes;
- unchanged central REST and DPoP behavior from ADR 0037;
- bounded in-memory delivery custody, an ID-only notification journal, and the
  encrypted, bounded pending-action exception;
- exact target-authorized action-result submission and correlated response
  delivery, the filtered pending-decision projection, the restart-safe
  unanswered-action list, the encrypted received-result list, removal only
  after successful result submission, and no general reply or local
  delivery-control tools;
- current package-owned Codex and Claude adapters, validated internal
  entrypoint launch, provider authentication ownership, normal
  provider-configured MCP and built-in tool access, and bounded asynchronous
  child-process failures;
- session list, history display, delete, forget, action-result retirement,
  30-day cleanup, and redacted verbose diagnostics;
- startup output with working MCP setup commands for all supported agents and
  safe operator diagnostics for each startup or delivery failure class;
- no separate connector process, user-selected webhook format, OpenClaw
  receiver plugin, old package alias, old CLI, compatibility reader, or
  migration path in the artifact; and
- local cleanup removes all enrollment and delivery state, refuses while the
  process lock is held, leaves provider and central state alone, and returns to
  the bootstrap catalog; and
- no credential, plaintext pending-action content, or plaintext received-result
  content leakage in databases, profiles, temporary files, packages, or
  qualification output.
