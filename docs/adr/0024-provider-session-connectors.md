# 0024 Provider session connectors

Status: proposed

Date: 2026-08-29

## Problem

The gateway can wake a local webhook and expose A2A tools through MCP, but it
does not control a model runtime. A multi-turn A2A conversation needs more than
one prompt per notification. Each later A2A message in the same conversation
must reach the same Codex thread, Claude session, or Gemini session.

Putting provider control into the gateway would conflict with ADR 0017. The
accepted gateway does not discover runtimes, select an adapter, configure local
applications, store runtime bindings, run a model, or hold model-provider
credentials. Its SQLite journal is also restricted to notification IDs and
relay state.

The shared design discussion also covered branding and direct integrations
with personal tools. Those topics are excluded here. Provider runtimes should
continue to use the MCP servers, extensions, tools, and permission controls the
user has already configured.

## Verified provider interfaces

The following first-party interfaces were checked on 2026-08-29:

| Provider | Stable session handle | Programmatic turn interface | Relevant persistence behavior |
| --- | --- | --- | --- |
| Codex | App Server `thread.id` | `thread/start`, `thread/resume`, and `turn/start` over stdio, Unix socket, or authenticated WebSocket | App Server stores thread history and can read or resume a recorded thread |
| Claude Code | Agent SDK `session_id` | `query()` returns a session ID and accepts `resume`; headless `claude -p` is a second candidate | Claude writes prompts, tool calls, tool results, and responses to its session history by default |
| Gemini CLI | Session UUID | Headless mode emits structured JSON or JSONL and `--resume` accepts a session ID | Gemini records prompts, responses, tool inputs, tool outputs, usage data, and available reasoning summaries |

Sources: [Codex App Server](https://developers.openai.com/codex/app-server),
[Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
[Claude headless mode](https://code.claude.com/docs/en/headless),
[Gemini headless mode](https://geminicli.com/docs/cli/headless/), and
[Gemini session management](https://geminicli.com/docs/cli/session-management/).

These interfaces make the shared conversation-to-session mapping feasible.
They do not provide a common protocol, a central A2A reply operation, or common
crash semantics.

## Proposed decision

Keep the gateway provider-neutral. Add separately launched, loopback-only
provider connectors. One connector is the gateway's one configured webhook
target. The connector, not the gateway, knows which provider it controls.

```text
Central A2A service
  |  bounded polling and authenticated reply
  v
Gateway core
  |  existing authenticated wake and loopback MCP
  v
One provider connector
  |  provider-native start, resume, turn, event, and approval interface
  v
Codex, Claude Code, or Gemini CLI
  |  user-configured MCP servers, extensions, and local tools
  v
User-approved local and remote capabilities
```

The connector flow is:

1. Receive the existing signed webhook wake on a literal-loopback listener.
2. Authenticate the bearer, timestamp, HMAC signature, `Host`, and optional
   `Origin` before reading the JSON body.
3. Deduplicate the opaque notification ID, then call the gateway's local
   `poll_messages` tool with the same local bearer.
4. Read the central `conversation_id` and message ID defined by ADR 0025.
5. Serialize work for that conversation. Different conversations may run in
   parallel only up to a fixed, reviewed limit.
6. Create a provider session for a new conversation or resume the mapped
   session for an existing conversation.
7. Submit the A2A content as untrusted user input. The sender cannot set the
   provider command, model, working directory, session ID, system prompt,
   sandbox, approval mode, tool list, MCP configuration, or environment.
8. Capture one bounded terminal response or a fixed failure state.
9. Send the response through the gateway's proposed `reply_message` tool.
10. Call `ack_message` only after the central service accepts that idempotent
    reply, or after the reviewed protocol says a terminal no-reply outcome may
    be acknowledged.

One gateway still owns one webhook target and one central identity. Supporting
more than one provider at once means running independent gateway and connector
pairs. This proposal does not add bindings, runtime discovery, configured
runtime agent IDs, or runtime selection to the gateway CLI.

Accepting this ADR would add companion connector products to the repository;
it would not turn the gateway itself into a runtime host. Update the product
boundary and implementation plan only after approval, with separate ownership
for gateway core, connector foundation, and each provider adapter.

## Gateway boundary

The gateway changes only where a provider-neutral conversation protocol needs
support:

- validate and retain the new central correlation fields in its bounded
  in-memory inbox;
- expose the reviewed `reply_message` operation without exposing the central
  JWT; and
- preserve the current wake, acknowledgement, authentication, singleton, and
  content-free durability rules.

The gateway does not spawn provider executables, import provider SDKs, inspect
provider state, persist provider session IDs, choose a working directory, or
modify provider configuration files.

The connector is the MCP client for delivery-control operations. It calls
`poll_messages`, `reply_message`, and `ack_message` itself. It does not need to
give the provider process the gateway bearer or expose those tools to the
model. Codex, Claude Code, and Gemini CLI continue to use the user's existing
MCP servers and extensions for local work. Allowing a model to initiate other
A2A actions through the gateway would need a separate narrowed tool and
credential decision; it must not happen implicitly as part of notification
delivery.

## Connector state boundary

The connector needs durable correlation state so a process restart does not
silently attach an existing A2A conversation to a new provider session. Its
store may contain only:

- schema version;
- opaque A2A `conversation_id`;
- opaque inbound message ID;
- provider kind;
- opaque provider session or thread ID;
- opaque provider turn ID when the provider supplies one;
- lifecycle state such as created, running, reply accepted, or uncertain; and
- bounded retry timing for operations that the central protocol declares
  idempotent.

It must not contain prompts, message payloads, attachments, responses, tool
arguments, tool results, provider credentials, central credentials, webhook
tokens, email addresses, verification codes, permission details, working
directory paths, or provider transcripts. It must be separate from the
gateway notification journal.

Treat provider session and turn IDs as sensitive local metadata. The exact
store format, access controls, encryption choice, deletion behavior, and
dependency choice require another ADR and user approval before production
implementation.

Provider-native session history is a separate boundary. Persistent multi-turn
resume normally causes Codex, Claude Code, or Gemini CLI to store conversation
and tool history under that provider's own state directory. The connector must
not copy that content, but setup documentation must disclose the provider's
storage and deletion behavior. A no-persistence mode may offer one-shot turns;
it must not claim multi-turn continuity.

## Execution and security rules

- Bind the connector webhook only to literal loopback and apply the gateway's
  existing header, body, timestamp, replay, and authentication limits.
- Never put A2A content in the wake body. Retrieve it through authenticated
  loopback MCP after the wake.
- Start provider processes without a shell. Send prompts through stdio or the
  provider's structured protocol, not command arguments, environment
  variables, temporary files, or generated scripts.
- Use the user's existing provider authentication. The gateway and connector
  must not request, copy, log, persist, or proxy model-provider credentials.
- Bind each connector to a user-approved working directory and security policy
  outside the gateway CLI. Remote A2A data cannot change either value.
- Preserve provider-native sandboxing, deny rules, MCP approvals, and local
  approval requirements. The connector cannot select a bypass or unrestricted
  mode merely because execution is headless.
- Treat every inbound message as hostile prompt content. Fixed connector
  instructions and provider policy stay outside sender-controlled fields.
- Bound provider stdout, stderr, JSON nesting, event count, response size,
  execution time, child count, and concurrency. Do not place provider streams
  in normal logs or diagnostics.
- Redact safe errors and terminate the complete child process group on timeout
  or cancellation.
- A repeated wake for a running message returns success without starting a
  second provider turn.
- A missing or invalid mapped provider session fails safe. Do not silently
  create a replacement session with partial context.

## Crash and uncertainty rules

The connector records the conversation-to-session mapping before it permits a
new provider turn to perform stateful work. It records an opaque provider turn
ID as soon as the provider supplies one.

A provider qualifies for stateful autonomous turns only if it exposes the new
session ID before any model tool can run. If its event ordering cannot
guarantee that, the first release must restrict that provider to non-stateful
work or another reviewed recovery design.

After a crash, the connector may recover a completed response only when the
approved provider interface can read that exact prior turn without starting a
new turn. If it cannot distinguish not-started, running, and completed, it
marks the inbound message `uncertain` and does not replay it automatically.
This avoids repeating tool calls or external side effects.

The central reply operation must be idempotent by inbound message ID. A crash
after central reply acceptance but before `ack_message` may therefore repeat
the reply request, but it must not create a second remote message. ADR 0025
defines that required contract.

## Provider-specific direction

### Codex

Use App Server as the first interface to qualify because it exposes persistent
threads, structured turns, streamed events, cancellation, and approval
requests. Prefer local stdio for the connector. Do not open an unauthenticated
WebSocket listener. Record `thread.id` for `thread/resume`; do not infer it from
another field. Pinning a Codex version and its generated protocol schema needs
a provider-specific ADR.

### Claude Code

Qualify the Agent SDK and headless CLI before selecting one. The Agent SDK has
structured session resume and permission callbacks but adds a production
dependency. The CLI offers structured output and session metadata but has a
subprocess contract. No SDK, package, or version may be selected or installed
without an approved dependency ADR.

### Gemini CLI

Qualify stable headless mode with `stream-json`, capture the session UUID from
the initialization event, and resume by the exact UUID. Do not base the first
connector on experimental ACP mode. Pinning the Gemini CLI version and exact
event schema needs a provider-specific ADR.

## Packaging and platform impact

This proposal does not add a provider package to the gateway artifact. Each
connector is a separate executable or package whose installation and release
model needs user approval. Its supported operating systems cannot exceed both
the gateway's qualified matrix and the selected provider runtime's qualified
matrix.

No SDK, library, executable version, license, or maintenance commitment is
selected by this record. Each provider-specific ADR must record version,
license, maintainer, release cadence, transitive dependencies, platform
support, update policy, and packed-install impact before installation or
production code.

## Alternatives

- Put all three adapters in the gateway. This couples central identity and
  credential custody to provider processes and conflicts with ADR 0017.
- Persist provider mappings in the gateway journal. This breaks the journal's
  notification-only role and makes the gateway runtime-aware.
- Configure only the gateway MCP server in each provider. MCP exposes tools but
  does not by itself receive a central wake, choose the matching provider
  session, or resume that session.
- Auto-discover, install, or configure provider runtimes. This expands local
  authority and conflicts with the approved manual, foreground design.
- Start a fresh provider session for every message. This loses the multi-turn
  context required by the shared design.

## Approval gates

Production work is blocked until:

1. ADR 0025's central conversation, recovery, and idempotent reply contract is
   complete and approved;
2. the user approves this connector boundary;
3. a connector-state storage ADR is approved;
4. the CLI or configuration interface for each separate connector is approved;
5. each provider dependency, executable version, and protocol schema is
   approved in its own ADR; and
6. publishing or installation changes are separately approved.

## Approval

Not approved. The user requested a planning handoff for Codex, Claude, and
Gemini support on 2026-08-29. This record proposes a boundary that preserves
the accepted gateway constraints and needs review before tests or production
code are written.
