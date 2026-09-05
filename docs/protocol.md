# Ambassador protocol

Status: delivery cutover in progress; current work is listed in
[Current work](implementation-plan.md)

[ADR 0061](adr/0061-durable-workflows-and-client-delivery.md) is the approved
target for durable receipt, typed message-box operations, structured owner
input, explicit client receipts, streaming and client-specific delivery.
The implementation plan distinguishes implemented behavior from outstanding
qualification.

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

When `start` or `clean` finds Ambassador running, an interactive terminal asks:

```text
Ambassador is already running. Stop it and start a new instance? [y/N]
Ambassador is already running. Stop it and clear local Ambassador state? [y/N]
```

Only `y` or `yes`, ignoring case and surrounding spaces, confirms the stop.
Empty, negative, and other answers leave Ambassador running. End of input and
cancellation also leave it running. Both standard input and standard error
must be terminals; non-interactive commands retain the `daemon_running` error.

The CLI first authenticates the private control route and reads its random
in-memory process instance ID. After confirmation, it requests graceful
shutdown of that exact instance and waits up to 30 seconds to acquire the
singleton lock. A changed instance rejects the request. An unavailable control
route, including a running version without these operations, requires the
owner to stop Ambassador in its terminal. There is no PID-based or forced
shutdown, and an unrelated process occupying the port is never stopped.

`clean` acquires the singleton process lock and refuses to continue if
shutdown does not release it or the lock artifact is invalid. While it owns the lock,
it removes every entry from the private Ambassador state directory except the
lock database, its active SQLite sidecars, and the diagnostics directory. This includes the encrypted
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
authorization for this local deletion. It asks a question only when another
Ambassador must be stopped; there is no force option.

The process acquires its singleton lock before reading central credentials, binding a
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
private keys, cookies, and webhook secrets. The same redacted events are retained in rotating development logs even without verbose.
ACP available-command catalogs and their descriptions are omitted; the log
records only the session ID and command count for that update.

## Local MCP

Every local MCP request uses Streamable HTTP at `/mcp` without bearer
authentication. Ambassador requires `Host: 127.0.0.1:8787`. A present
`Origin` must be exactly `http://127.0.0.1:8787`. A supplied `Authorization`
header is rejected. Host and Origin checks happen before body parsing.

The same listener has a non-MCP private control route used only by Ambassador's
CLI for live session reads and confirmed process shutdown. It requires exact loopback Host, rejects every
Origin, requires the generated encrypted internal bearer secret, and accepts
only exact bounded `sessions.list`, `sessions.show`, `process.status`, and
`process.stop` operations. Status returns only an instance ID; stop requires
that ID and acknowledges the request before starting graceful shutdown. The route,
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
| Concurrent ordinary tool calls | 8 |
| Concurrent held message-box calls | 32 |
| Serialized structured tool result | 768 KiB |

MCP sessions expire after 30 minutes without activity. At capacity, the oldest
inactive session can be reclaimed. Active requests, tools, and streams prevent
reclamation. Requests using expired IDs return 404 and clients initialize
again. HTTP connection closure alone does not terminate a logical session.

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

Advertise six tools before and after enrollment: `register_agent`,
`verify_email`, `resend_verification`, `list_action_types`,
`get_my_permissions`, and `message_box`. Bootstrap tools return
`already_enrolled` after enrollment. Protected work requires enrollment.
Expired credentials retain access to local inboxes, saved operation checks and
receipts, while central work reports `credential_expired`.

MCP initialization includes a local enrollment snapshot. Successful
`get_my_permissions` and `list_action_types` responses include `enrollment`
with `status: "registered"`, `verified: true`, `agent_id`, `email` and
`credential_status: "active"`. An empty permission list means no permission
records, not an unregistered account. Later verification and tool results
supersede the initialization snapshot. Initialization for an expired credential
still identifies the registered account and reports `credential_status:
"expired"`; protected operations retain their normal expiry error. Only the
allowlisted public identity fields are exposed. See [ADR 0062](adr/0062-explicit-local-enrollment-context.md).

`message_box` is a strict discriminated union. Unknown fields fail validation.

| Type | Purpose and required input |
| --- | --- |
| `request_action` | New request UUID, exact catalog action name, target email, exact object payload; optional decision menu, reason, scope and wait |
| `request_permission` | New request UUID, exact catalog name, target email or triggering message ID; no action payload |
| `submit_action_result` | New request UUID, pending call UUID, success/error status and result object |
| `check` | Existing request UUID; optional event cursor and wait |
| `acknowledge` | Existing request UUID and returned event cursor |
| `inbox` | Optional limit 1..100 and opaque pagination cursor |
| `acknowledge_results` | Received call UUIDs from the inbox |
| `ask_owner` | New request UUID, pending call UUID, question, text/buttons input type and exact button options when applicable |
| `answer_owner` | New answer request UUID, question UUID, matching pending call UUID and exact text or button value |
| `check_owner` | Existing owner-question request UUID |

A mutation UUID identifies immutable input. Repeated identical submissions
observe existing state. Changed input under that UUID fails. Owner questions
have their own request namespace; answer UUIDs belong to their question.
`wait_seconds` is observation metadata and may change without changing identity.
Request-action, request-permission and check calls default to a 600-second
deadline including submission. An explicit 0..600-second wait supports constrained
clients. Timeout returns the same request ID and a check continuation. The agent
tells the user they can ask again. There is no scheduled retry or new submission.

Events carry receipt cursors. Reading a check or inbox never consumes results.
A check with a previous cursor acknowledges those events before waiting for
later events. Explicit receipts durably precede result removal. Cancellation
ends observation, not accepted work. Uncertain external outcomes are retained
and never automatically repeated. The API has no reconciliation endpoint.

Inbox pages visit pending calls, unread results, then outbound intents in
insertion order. The default limit is 50, maximum 100, with a 500 KiB page
target and complete first record. A serialized tool response is capped at
768 KiB. Follow `next_cursor` until absent. Counts describe the current page.
Pending calls include reply instructions and any saved owner question. Permission
decisions remain in email and operation events, not the inbox. This tool does
not poll central or control delivery.

Incoming receipt and central acknowledgements belong to Ambassador. There are
no local `poll_messages`, `ack_message`, separate business tools, arbitrary
chat, or outcome-lookup tools. Action catalog entries remain data, not new tools.
Catalog input schemas are checked in a bounded worker using the installed SDK's
standards validator. No names, values or defaults are rewritten. Unsupported
schemas fail explicitly. Central currently publishes no action result schemas.
Credential-like fields and stored credential bytes cannot enter tool arguments,
results or diagnostic output.

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
| Ask the local agent's owner | `POST /api/get_human_input` | internal only; bounded question, `text` or `buttons`, exact options for buttons, triggering `message_id` |
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
`permission_outcome` to the requester. A permission-only request produces a
status notification; it supplies no action payload. Ambassador does not handle
the email token or call central's unauthenticated decision endpoint during
normal use.

An `allow_once` grant permits one action call. `allow_always` and the simpler
`accept` decision are standing grants. If central returns
`already_granted: true`, the requester can proceed immediately and no new
approval email was sent.

The `message_box` request-action variant saves exact outbound intent before
requesting permission. Only one outstanding intent per target/action pair is
admitted. A matching permission grant dispatches its exact payload once.
The action name, permission ID and grantor must match. An existing grant can
permit immediate dispatch. A permission-only request has no payload and never
creates work. Broad-sounding permission names do not authorize different action
types. Central checks the exact action UUID, current grantee identity, grantor,
expiry and remaining uses.

Persisted outbound states distinguish awaiting permission, ready, submitted,
denied, confirmed rejection and uncertainty. A fresh explicit request may replace
a denied or confirmed-rejected intent. Uncertain work cannot be replaced or
automatically retried. A saved call or permission ID can repair a partially saved
operation after restart without another external submission. A received action
result clears submitted outbound intent after durable capture.

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

One receiver calls `poll_messages?timeout=30` under a 40-second HTTP deadline.
It validates and atomically captures the entire bounded batch in encrypted
notification custody before processing or acknowledgement. Maximum batch size
is 256 messages and 512 KiB. Duplicate IDs with identical canonical contents are
ignored; conflicting contents fail the batch. A quota or disk failure admits no
partial batch and stops reception.

Independent bounded workers process events, deliver provider prompts, and
acknowledge central. Shared encrypted human-input custody replaces the competing
ACP approval poller. An ACP turn waiting on its owner cannot stop receipt of its
answer. Provider failure pauses provider delivery and preserves uncertainty;
reception, operation updates and acknowledgements continue.

Persist dispatch intent before a provider invocation and acknowledgement intent
before sending it. Restart resumes prepared work, marks interrupted external
attempts uncertain, and never replays a dispatched prompt. Recovery uses bounded
batches. Completed custody records compact to ID/fingerprint tombstones after
processing and acknowledgement settle. Business result receipt is separate.

Owned outgoing permission/result events wake their operation waiter instead of
creating an unrelated ACP conversation. Incoming action calls go to the selected
incoming delivery profile. A matching owner answer resumes that call's original
peer session once. Duplicate or stale answers cannot start another continuation.
Unowned valid notifications use the configured incoming profile.

The server currently marks rows delivered before returning the poll response.
Local custody cannot repair a response lost before capture. Server recovery and
listener fixes remain API issues; this protocol does not promise exactly-once
delivery.

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
  "sessionMode": "persistent",
  "sessionKey": "hook:ambassador:<SHA-256 of enrollment, receiver, provider and requester>",
  "deliver": false
}
```

Ambassador does not send HMAC-v2, timestamp, or request-ID headers to OpenClaw.
ADR 0063 fixes the session key to the enrollment key thumbprint, canonical
receiver URL, provider agent ID and top-level central sender identity. Payload
fields cannot choose the destination. Restart preserves the peer conversation;
new enrollments and different requesters remain separate. The receiver enables
request session keys with the restricted `hook:ambassador:` prefix.
OpenClaw's native hook authenticates the bearer, applies its agent allowlist,
uses the idempotency key for bounded replay handling, safety-wraps external
content, and admits a normal model turn. The native request body may not exceed
256 KiB. The Hermes canonical body retains its 512 KiB limit.

A `2xx` means the receiver accepted responsibility for the complete message.
Ambassador records that transfer independently of central acknowledgement, which
follows encrypted local custody. A non-`2xx`
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
| OpenClaw | `openclaw-bundle-mcp` | `openclaw acp --no-prefix-cwd` | `openclaw-acp` | provider configuration |
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

Ambassador initializes the agent and reuses a persistent session for a
central-issued remote `sender_agent_id`, scoped to the enrolled DPoP identity,
fixed provider, and canonical working directory. Payload-supplied identities
never select a session. It requires `session/resume` or `session/load`, preferring
resume without history replay. OpenClaw's reviewed profile requires load to
recover its gateway session mapping across process restarts. Each message has its own dispatch state and each
action its own completion correlation. Only a prepared message may retry;
dispatched, completed, or uncertain messages cannot be prompted again.

Provider configuration owns model context and automatic compaction. Compaction
does not settle an action or prune Ambassador's stores. During `session/load`,
Ambassador streams and discards history, bounds each NDJSON event, and retains
no replay transcript. New turn output retains its 4 MiB cumulative bound.
Session inspection keeps at most a 512 KiB recent preview and labels truncation.

An ACP tool permission request remains open while Ambassador calls central's
`get_human_input` for its own owner. It sends every provider option in order,
using the exact name as the button label and exact option ID as the value.
Labels and IDs must fit 1..64 characters, there must be 1..10 options, and values
must be unique. Invalid menus fail before email submission. The selected value
must match an offered ID and returns unchanged. No approval-kind mapping or
automatic approval is allowed.

The independent central receiver captures responses in the shared encrypted
mailbox. Correlation checks request ID, triggering message ID, prompt, input
type, action and exact offered value. There is no approval-specific central
poller. The control answer is consumed internally, never submitted as another
ACP prompt. Normal prompt and outer delivery deadlines pause during this
explicit human approval wait.

Every provider prompt has a short fixed untrusted-data warning and a compiled
cue for its message type, followed by the complete central JSON.
JSON uses two-space indentation inside a fenced `json` block. OpenClaw's fixed
`--no-prefix-cwd` option hides its directory banner; the real ACP working
directory and peer-session binding remain unchanged. Detailed
workflow instructions load through MCP initialization instead of appearing in
every conversation message. Unknown types get an inbox cue and never an action
instruction. Permission outcomes still forbid constructing an action; owner
answers remain bound to their named call. The provider uses `message_box` to
answer known calls with structured success or a definitive error. If user
information is missing, `ask_owner` saves a question before sending a text or
button email and returns `waiting_for_owner`. The ACP turn may finish. The
answer resumes only the pending call, with its saved peer and action context.
The question is bounded to 2,000 characters; text answers to 4,000. A foreground
`answer_owner` binds the supplied answer to the same question and call.
It saves the answer before enqueuing a local provider continuation. The answer
UUID identifies that continuation for deduplication; it is never acknowledged
to central. Interrupted local handoffs are recovered in bounded batches.
Any ACP approval during the resumed turn refers to the original central-issued
action notification, not the local answer UUID.
Free-form model output is never interpreted as a workflow command.

A finished ACP turn is not a completed action and not evidence of user
presentation. Pending calls remain until accepted result submission. Provider
history remains with the provider; Ambassador keeps identifiers, bounded
in-memory inspection and encrypted workflow records.

Optional original-conversation return is separate from this incoming execution
profile. The OpenClaw provider extension captures the logical session key in a
trusted tool hook. Its ID-only route journal lives in provider state. It checks
the existing operation, injects the returned data through reviewed `chat.inject`,
and then acknowledges the event. The API appends to the current history behind
that logical key, including after a reset; it does not pin an old history instance.
Ambiguous injection is not repeated. A missing route leaves the result unread.

The experimental Claude Code stdio channel proxy captures its own process
conversation, returns acceptance immediately, and sends `claude/channel`
notifications. Notification acceptance is not display or human receipt, so
results remain unread. Routes last for that channel process. Hermes native
return remains unqualified because the reviewed public hooks do not supply the
gateway routing key or an idle-only injection operation. It uses foreground
long polls. See [Client delivery](client-delivery.md) for configuration and limits.

## Central acknowledgement

Acknowledge a central message only after durable local custody. This confirms
that Ambassador owns the captured record; it does not certify model execution,
action completion, client acceptance or human display. A missing central ID is
not acknowledged. A failed or interrupted acknowledgement is recorded uncertain
and is not retried against the current non-idempotent API.

Webhook `2xx` confirms receiver acceptance. Direct completion confirms a provider
turn finished. Neither consumes a returned business result. Only an explicit
message-box receipt, or a qualified native display receipt, does that.

## Deadlines and data boundary

| Operation | Deadline |
| --- | --- |
| Central REST call | 30 seconds |
| Central message long poll | 40 seconds for a 30-second server hold |
| Ordinary local MCP request | 35 seconds |
| Message-box business wait | 600 seconds by default |
| Local MCP wait transport | 640 seconds |
| Lock acquisition after confirmed process shutdown | 30 seconds |
| Webhook delivery | 10 seconds |
| ACP process initialization | 15 seconds |
| ACP session creation or resume | 15 seconds |
| ACP prompt | 15 minutes |
| ACP session close | 15 seconds, capped by the remaining outer budget |
| ACP cancellation grace | 10 seconds |
| ACP child cleanup | 5 seconds |

One 15-minute-and-30-second outer ACP delivery budget includes all ACP stages.
A stage never extends it except while waiting for the explicit human approval
described above. Tests may inject shorter positive deadlines through
internal seams. No deadline is a CLI option.

Development diagnostics always record bounded request/response bodies and
workflow events after mandatory credential redaction. Startup prints the
owner-only diagnostics directory. Four JSONL files of at most 8 MiB each, a
64 KiB record cap and a bounded queue limit retention. Disk failures and dropped
records are reported. `clean` preserves these logs. Verbose adds console output.
Logs are never recovery input. The user approved keeping this detailed retention
for the development release on 2026-09-05. Later production releases must review
that policy separately.

Tokens, verification codes, private keys, proofs, nonces, cookies and webhook
secrets are excluded before diagnostics or tool result handling. The central
token and DPoP private key live only in one atomic encrypted credential. Its
wrapping material is generated internally in a separate owner-only file. The
webhook and private control secrets have separate encrypted scopes. Provider
credentials remain with providers.

Encrypted workflow stores hold notifications, pending calls, received results,
outbound intent, operation events, owner questions and human-input responses.
Each allows 1 GiB of live ciphertext and 512 KiB per record; operation events
have an additional 32 KiB/32-event bound. Domain-separated keys bind stores to
enrollment. Indexed reads and transactional counters avoid full body scans.
SQLite indexes, free pages and WAL files add disk overhead. Calls and unread
results have no automatic expiry. Native route journals contain identifiers and
delivery state only, capped at 10,000 records and 32 observers.

This development cutover uses new schemas directly. Migration is out of scope.
Unknown schemas and changed identity bindings fail closed. `clean` clears local
enrollment and workflow state after proving Ambassador stopped, preserving
diagnostics and provider configuration. It never deletes or resets central
identity. Central identity/credential recovery remains server work.

## Acceptance cases

[Workflow tests](workflow-test-plan.md) define deterministic regression cases.
[Qualification](qualification.md) records exact live evidence, package identity,
provider configuration and remaining limits. Fixtures and HTTP success alone
cannot qualify a desktop conversation.
