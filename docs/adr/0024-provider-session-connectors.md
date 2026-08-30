# 0024 Provider session connectors

Status: accepted

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

## Decision

### Accepted boundary

Acceptance of this ADR freezes only these invariants:

- Provider control belongs in a separately launched foreground connector, not
  in the gateway. The gateway remains provider-neutral and its CLI is
  unchanged.
- One gateway, one connector, and one provider runtime form one pair. The
  connector is that gateway's one configured webhook target.
- The connector receives the existing loopback webhook wake and retrieves A2A
  content through the gateway's authenticated local MCP endpoint. Content does
  not move into the wake body.
- The connector owns correlation between an A2A conversation and a provider
  session. Any durable correlation remains content-free and separate from the
  gateway journal.
- The central credential stays in the gateway. Provider credentials stay in
  the provider runtime. The connector transfers neither credential.
- When provider work may have occurred and the exact outcome cannot be
  recovered, the connector fails closed as uncertain and never replays the
  provider turn blindly.

This acceptance does not fix a connector command, configuration interface,
state schema or mechanism, cryptography, numeric limit, process protocol,
working-directory or approval policy, runtime dependency, provider interface,
transport, package, platform, installation method, or publishing path. D05
must approve the connector-wide choices. Each provider-specific ADR must
approve its own interface and dependency choices.

### Conceptual boundary

The following diagram is explanatory, not an accepted process or provider
protocol:

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

A possible process for D05 to review is:

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
9. Send the response through the gateway's accepted `reply_message` tool.
10. Call `ack_message` only after the central service accepts that idempotent
    reply, or after the reviewed protocol says a terminal no-reply outcome may
    be acknowledged.

One gateway still owns one webhook target and one central identity. Supporting
more than one provider means running independent gateway and connector pairs.
This boundary adds no bindings, runtime discovery, configured runtime agent
IDs, or runtime selection to the gateway CLI. Gateway core, the connector
foundation, and each provider adapter remain separate ownership areas.

## Gateway boundary

This approval authorizes no provider-specific gateway behavior or gateway CLI
change. ADR 0025 and G04 already own the provider-neutral gateway work on which
a connector would rely:

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

The accepted invariant is a separate, content-free correlation store owned by
the connector. D05 must approve the exact technology, schema, cryptography,
locking, access control, lifecycle, deletion, and fresh-install behavior. A
later state proposal may need field categories such as:

- schema version;
- opaque A2A `conversation_id`;
- opaque inbound message ID;
- provider kind;
- opaque provider session or thread ID;
- opaque provider turn ID when the provider supplies one;
- lifecycle state such as created, running, reply accepted, or uncertain; and
- bounded retry timing for operations that the central protocol declares
  idempotent.

Regardless of mechanism, connector durability must not contain prompts,
message payloads, attachments, responses, tool arguments, tool results,
provider credentials, central credentials, webhook tokens, email addresses,
verification codes, permission details, working directory paths, or provider
transcripts. It must remain separate from the gateway notification journal.

Provider session and turn IDs are sensitive local metadata. D05 must decide how
to protect them and must approve any storage dependency before connector tests
or production implementation.

Provider-native session history is a separate boundary. Persistent multi-turn
resume normally causes Codex, Claude Code, or Gemini CLI to store conversation
and tool history under that provider's own state directory. The connector must
not copy that content, but setup documentation must disclose the provider's
storage and deletion behavior. A no-persistence mode may offer one-shot turns;
it must not claim multi-turn continuity.

## Security questions for D05

The accepted boundary requires loopback wake delivery, MCP content retrieval,
credential separation, content-free durability, and fail-closed uncertainty.
D05 must turn the following candidates into an exact security and process
policy before tests or code:

- define webhook header, body, timestamp, replay, authentication, and deadline
  limits for the literal-loopback listener;
- choose a prompt transport that keeps A2A content out of command arguments,
  environment variables, temporary files, and generated scripts, and decide
  whether every provider process can start without a shell;
- define how the user selects a working directory and security policy outside
  the gateway CLI, and how the connector prevents remote A2A data from
  changing either value;
- define how provider sandboxing, deny rules, MCP approvals, and local approval
  requirements work in headless execution without selecting a bypass mode;
- define fixed bounds for provider stdout, stderr, JSON nesting, event count,
  response size, execution time, child processes, and concurrency;
- define safe error redaction, timeout and cancellation cleanup, repeated-wake
  handling, and behavior for a missing or invalid mapped provider session; and
- define fixed connector instructions that keep sender-controlled content from
  becoming a command, model, session, system prompt, tool, sandbox, approval,
  MCP, or environment setting.

## Crash and uncertainty rules

The accepted result is fail-closed uncertainty with no blind provider-turn
replay. D05 must decide the exact persistence ordering and common recovery
protocol. Each provider-specific ADR must then prove when its session and turn
IDs become available and whether it can read an exact prior turn without
starting another one.

A candidate design would publish the conversation-to-session mapping before a
new provider turn can perform stateful work and publish the opaque turn ID as
soon as the provider supplies it. This ordering is not accepted by this ADR.
If a later approved design cannot distinguish not-started, running, and
completed work after a crash, the connector must mark the inbound message
`uncertain` and must not replay it automatically.

The central reply operation must be idempotent by inbound message ID. A crash
after central reply acceptance but before `ack_message` may therefore repeat
the reply request, but it must not create a second remote message. ADR 0025
defines that required contract.

## Unaccepted provider-specific candidates

The feasibility evidence above does not select an interface, transport,
executable or SDK version, event schema, dependency, sandbox, approval mode,
history policy, or recovery mechanism. CX01, CL01, and GM01 own those later
decisions.

### Codex

Codex App Server is one candidate to qualify because the checked interface
exposes persistent threads, structured turns, streamed events, cancellation,
and approval requests. CX01 must decide whether to use it, pin an exact Codex
version and generated schema, and test whether `thread.id` arrives early enough
for safe stateful work and supports exact-turn recovery. Local stdio is one
transport candidate. Unix sockets or authenticated WebSockets require their
own transport review; no transport is selected here.

### Claude Code

The Agent SDK and headless CLI are candidates for comparison. The checked SDK
interface has structured session resume and permission callbacks but would add
a production dependency. The checked CLI offers structured output and session
metadata but would add a subprocess protocol. CL01 must determine which, if
either, exposes the session early enough, preserves the approved permission
policy, supports cancellation and exact-turn recovery, and has an acceptable
dependency and history boundary. No interface, package, or version is selected
here.

### Gemini CLI

Gemini CLI headless mode with `stream-json` is one candidate because the
checked interface emits structured events and a session UUID that later work
could test for exact resume. GM01 must pin and qualify a candidate CLI version,
decide the accepted event subset and prompt transport, and prove UUID timing,
sandbox and approval behavior, cancellation, retention, and crash recovery.
Experimental ACP is not selected and would require separate review. No Gemini
interface or event schema is accepted here.

## Packaging and platform impact

The accepted boundary keeps connector code and provider dependencies out of
the gateway artifact. D05 must decide the connector package or executable
layout, installation and release model, and initial platform claims. A later
platform claim cannot exceed both the gateway's qualified matrix and the
selected provider runtime's qualified matrix.

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

## Remaining approval gates

Connector tests and production work remain blocked until D05 approves:

1. the connector executable, CLI or configuration interface, working-directory
   input, and local security-policy input;
2. the correlation-store technology, schema, access control, encryption,
   deletion, and fresh-install behavior;
3. fixed concurrency, timeout, event, process, output, and response limits;
4. the common runtime and dependencies, plus each provider interface,
   executable or SDK version, and protocol schema;
5. local approval behavior and the mapping from provider results to terminal
   or uncertain outcomes; and
6. packaging, installation, supported platforms, and publishing gates.

## Approval

Approved by the user on 2026-08-30. The accepted boundary is limited to
separate foreground connector companions while the gateway and its CLI remain
unchanged; one gateway, connector, and provider form one pair; the connector
receives the loopback webhook wake and retrieves content through the local
gateway MCP endpoint; the connector owns content-free correlation state; no
central credential leaves the gateway, no provider credential leaves the
provider runtime, and a provider turn with an uncertain outcome is never
replayed blindly.

This approval does not complete D05 or approve a connector command, storage
technology or schema, cryptographic design, limit, dependency, provider
interface, approval policy, package, installation method, platform claim, or
publishing change.
