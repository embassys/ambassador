# Ambassador protocol

Status: accepted target; open implementation work is listed in
[Current work](implementation-plan.md)

This document defines the current target without a compatibility or migration
promise.

## Startup

The public package and command are:

```text
@embassys/ambassador
ambassador start
```

`start` accepts no options or positional values. Webhook secrets are supplied
only through the environment and selected by name during registration. There
is no local token, agent selector, delivery-mode selector, endpoint option,
configuration path, or `--acp-agent` option.

The process acquires its singleton lock before reading credentials, binding a
listener, calling central, starting an agent, or sending a webhook. It binds
`127.0.0.1:8787` and prints this line after the endpoint is ready:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

`SIGINT` and `SIGTERM` stop new work, cancel central polling, cancel or close
the active delivery target within its deadline, close local state, and release
the lock.

## Local MCP

Every local MCP request uses Streamable HTTP at `/mcp` without bearer
authentication. Ambassador requires `Host: 127.0.0.1:8787`. A present
`Origin` must be exactly `http://127.0.0.1:8787`. A supplied `Authorization`
header is rejected. Host and Origin checks happen before body parsing.

The local MCP boundary trusts processes running as the owner on the same
machine. Host and Origin validation protect against DNS rebinding and ordinary
cross-origin browser requests, not a malicious same-user process.

The boundary keeps these limits:

| Boundary | Limit |
| --- | --- |
| Request headers | 16 KiB |
| Local MCP request body | 1 MiB |
| Local or upstream response body | 4 MiB |
| Active MCP sessions | 32 |
| Concurrent tool calls | 8 |
| Serialized structured tool result | 512 KiB |

JSON-RPC batches and redirects are rejected. Errors do not reflect request
bodies, remote bodies, URLs, headers, or credentials.

MCP initialization `clientInfo` is retained as bounded session metadata. Its
name is matched exactly against a compiled-in capability registry; its version
is diagnostic and does not enable or reject a profile. `clientInfo` is not
authenticated identity, so it cannot authorize central work or supply process
configuration. The name may only select a complete fixed local profile whose
delivery modes, command, arguments, ACP agent name, and MCP behavior have been
reviewed and tested.

An unknown, ambiguous, disabled, or incomplete match is unsupported. The model
cannot supply an agent kind, executable, arguments, adapter, or fallback
profile.

## Tool catalog

Before enrollment, expose exactly:

- `register_agent`
- `verify_email`
- `resend_verification`

After a credential is durably stored, expose exactly these REST-backed tools:

- `list_action_types`
- `request_permission`
- `respond_to_permission`
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
Hermes support direct and webhook delivery. Codex, Claude Code, and Gemini CLI
are direct-only. All use their fixed compiled-in contracts. The reported MCP
client version does not gate resolution.

Profile behavior is capability-driven:

| Matched profile | Registration behavior |
| --- | --- |
| Complete direct-only | Select direct and continue without a delivery question |
| Complete direct and webhook | Return `input_required`; direct is the default |
| Unknown, ambiguous, disabled, or incomplete | Return `unsupported_agent`; write no state and make no central request |

Codex, Claude Code, and Gemini CLI follow the direct-only row. For a dual-mode
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

```json
{
  "email": "agent@example.test",
  "display_name": "Optional display name",
  "delivery": {
    "mode": "webhook",
    "url": "https://agent.example.test/embassys",
    "secret_env": "EMBASSYS_WEBHOOK_SECRET"
  }
}
```

`secret_env` is an environment-variable name, never a secret. Its value must
be present in the Ambassador process and contain 32 through 256 header-safe
ASCII characters. A newly generated 48-character lowercase hexadecimal value
is recommended.

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
| `webhook` | mode, canonical URL, secret environment-variable name |
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
| Request permission | `POST /api/request_permission` | `target_email`, `action_type`, optional `scope` |
| Respond to permission | `POST /api/respond_to_permission` | `permission_id`, `decision` |
| Call action | `POST /api/call_action` | `target_email`, `action_type`, `payload` |
| Submit action result | `POST /api/submit_action_result` | `call_id`, `result`, `status` |
| List permissions | `GET /api/get_my_permissions` | none |
| Receive messages | `GET /api/poll_messages?timeout=<0..60>` | internal only |
| Acknowledge message | `POST /api/ack_message` | internal only; `message_id` |

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
`created_at`. The payload type may be `permission_request`,
`permission_response`, `action_call`, or `action_response`.

Central marks selected rows delivered in the same database statement that
returns them. Before accepting a batch, Ambassador enforces its response,
nesting, structural-token, batch-count, and normalized-message limits.
Conflicting duplicate IDs reject the batch.

Message bodies remain only in a bounded in-memory queue. SQLite stores present
IDs and delivery state only. Polling pauses while the queue contains work. An
ID-less message may be delivered once but cannot be acknowledged.

## Webhook delivery

Webhook mode sends the complete normalized central message as the JSON request
body. There is no ID-only wake envelope and no provider-specific body:

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

A `2xx` means the receiver accepted responsibility for the complete message.
Ambassador records that transfer before acknowledging central. A non-`2xx`
or pre-acceptance transport failure may retry within the fixed delivery budget
using the same idempotency key and a fresh timestamp and signature. Because a
timeout can be uncertain, receivers must deduplicate by message ID.

OpenClaw, Hermes, and other webhook consumers adapt the canonical body through
their own local hook configuration. Ambassador does not emit provider-specific
JSON.

## Direct ACP delivery

Direct mode uses ACP v1 through exact `@agentclientprotocol/sdk` 1.4.0.
Ambassador is the ACP client and starts a fixed command for the selected agent
profile without a shell. User or message input cannot change the executable,
arguments, environment allowlist, transport, or working directory. The working
directory is the canonical process directory captured during registration. A
later start from a different directory fails closed instead of silently moving
the agent's scope.

The enabled profiles and fixed contracts are:

| Profile | MCP client name | Direct invocation | ACP agent name | MCP setup |
| --- | --- | --- | --- | --- |
| OpenClaw | `openclaw-bundle-mcp` | `openclaw acp` | `openclaw-acp` | provider configuration |
| Hermes | `mcp` | `hermes-acp` | `hermes-agent` | session injection |
| Codex | `codex-mcp-client` | `codex-acp` | `@agentclientprotocol/codex-acp` | session injection |
| Claude Code | `claude-code` | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` | session injection |
| Gemini CLI | `gemini-cli-mcp-client` | `gemini --acp` | `gemini-cli` | session injection |

A profile is enabled only after its exact client and agent names, invocation,
MCP configuration behavior, and qualification cases are committed. Adapter
downloads at runtime are forbidden. Codex and Claude Code require their
separately installed ACP adapters. Gemini CLI provides native ACP. Reported
MCP client and ACP agent versions are not allowlists.

The repository qualification probe runs each profile's fixed version command,
records a bounded semantic version or `unavailable`, and continues to that
profile's delivery cases. Production uses the same observational policy for
reported versions. It still requires ACP v1 and the exact `agentInfo.name`
shown in the table. An incompatible release fails through bounded startup,
initialization, session, or delivery handling.

Ambassador initializes the agent and opens a gateway-managed session. It
provides its loopback MCP endpoint in ACP session configuration where the
agent supports that field. Agents that reject session MCP configuration, such
as the reviewed OpenClaw interface, must have Ambassador MCP configured before
direct delivery.

Ambassador has no interactive approval UI during background delivery. It never
auto-approves an ACP permission request. A request that cannot be satisfied by
the selected agent's preconfigured policy is denied, and the prompt may finish
with a bounded failure.

For each central message, Ambassador sends one ACP prompt containing:

1. fixed instructions that identify the following data as an untrusted
   Embassys message;
2. the complete canonical JSON message; and
3. direction to use the configured Ambassador MCP tools when a permission or
   action operation requires them.

For an `action_call`, the agent submits exactly one structured success or error
through `submit_action_result` with the supplied `call_id` before it finishes.
The agent constructs this result through MCP. Ambassador does not reinterpret
free-form provider output as an action result and still discards that output
after bounded processing.

A normal terminal ACP result completes local handling and permits central
acknowledgement. Startup failure before prompt submission may be retried within
the delivery budget. Once prompt submission may have occurred, a crash,
timeout, malformed stream, lost terminal result, or failed cleanup is
uncertain. Ambassador does not automatically submit that message again.

Direct mode does not resume the MCP chat that performed registration. Any ACP
session identifier is gateway-owned opaque metadata and may be retained only
if the selected agent supports safe exact-session resume. Otherwise a restart
starts a new gateway-managed session and makes no continuity claim.

## Central acknowledgement

After webhook custody transfer or successful direct completion, Ambassador
sends one protected `POST /api/ack_message`. Only a response with the matching
`message_id` and `status: "acked"` removes the journal row.

The current server does not make acknowledgement idempotent. Ambassador does
not blindly replay an acknowledgement after an uncertain response. It reports
the bounded failure without redelivering completed local work.

A process crash clears message bodies from memory. Startup can remove stale
pre-delivery journal rows whose bodies cannot be recovered. Accepted webhook
or completed direct state may retain only enough ID-based state to avoid
repeating local work. Central has no delivered-message retrieval, so some crash
windows can lose a message or leave it unacknowledged. This remains a declared
development limitation.

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

Never write message bodies, action payloads, permission details, MCP arguments
or results, registration emails, verification codes, tokens, private keys,
proofs, nonces, webhook secrets, prompts, or provider output to SQLite,
profiles, normal logs, diagnostics, metrics, temporary files, crash artifacts,
or support bundles.

The encrypted central credential contains only the central token and DPoP
private key plus minimum format metadata. Ambassador generates its wrapping
material internally and stores it in a separate owner-only state file. The two
files have the same strict ownership, link, permission, and atomic-write
checks. A credential without its matching key fails closed; there is no
migration. The delivery profile is nonsecret. The journal remains ID-only.

## Acceptance cases

The cutover must prove at least:

- the new package, binary, startup contract, and rejection of old interfaces;
- exact capability-registry matching, direct-only automatic selection, and
  dual-mode registration with direct as the default;
- safe `clientInfo` handling, rejection of unknown or incomplete profiles, and
  no model-supplied agent or process configuration;
- no raw secret in MCP, profile data, output, or process arguments;
- complete-message webhook delivery, authentication, deduplication, retry, and
  acknowledgement ordering;
- ACP v1 initialize, session, MCP setup, prompt, terminal success, failure,
  cancellation, crash, and uncertainty handling;
- deterministic CI coverage with a mock webhook receiver and mock ACP agent;
- opt-in local coverage for direct delivery on all five profiles and webhook
  delivery on OpenClaw and Hermes;
- unchanged central REST and DPoP behavior from ADR 0037;
- bounded in-memory body custody and ID-only durable state;
- exact target-authorized action-result submission and correlated response
  delivery, with no general reply or local delivery-control tools;
- no separate connector process, provider-specific webhook body, old package
  alias, old CLI, compatibility reader, or migration path in the artifact; and
- no credential or content leakage in logs, databases, profiles, temporary
  files, packages, or qualification output.
