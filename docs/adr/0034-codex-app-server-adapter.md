# 0034 Codex App Server adapter

Status: accepted

Date: 2026-08-30

## Problem

ADRs 0024 and 0028 through 0031 define a provider-neutral connector, but they
do not select a Codex interface. CX01 must fix one exact Codex release,
transport, schema, thread and turn recovery rule, sandbox mapping, approval
behavior, history boundary, and update policy before CX02 can write a red
adapter specification.

This decision must keep untrusted A2A input out of process arguments and local
authority settings. It must also preserve the common rule that a turn is never
replayed when the exact prior result cannot be recovered.

The primary interface reference is the
[official Codex App Server documentation](https://developers.openai.com/codex/app-server).
The protocol implementation is open source in
[`openai/codex`](https://github.com/openai/codex/tree/rust-v0.149.0/codex-rs/app-server-protocol).

The official documentation sections for the
[wire protocol](https://developers.openai.com/codex/app-server#protocol),
[version-specific schema generation](https://developers.openai.com/codex/app-server#message-schema),
[lifecycle](https://developers.openai.com/codex/app-server#lifecycle-overview),
[turn interruption](https://developers.openai.com/codex/app-server#interrupt-a-turn),
and [approvals](https://developers.openai.com/codex/app-server#approvals) are
the primary behavioral sources. The generated 0.149.0 stable schema is the
authority for exact fields and wire shapes in this record.

## Local spike evidence

The CX01 spike inspected the installed Codex runtime without changing its
configuration, authentication, or history:

| Observation | Value |
| --- | --- |
| Resolved installation | Standalone `aarch64-apple-darwin` release |
| `codex --version` | `codex-cli 0.149.0` |
| Release metadata | `codex-package.json` version `0.149.0` |
| Canonical binary SHA-256 | `f4a74117b8142cda581c95ff753abf4508b5636d89682c1ed77e4a9249af8963` |
| Stable schema command | `codex app-server generate-json-schema --out <empty-directory>` |
| Stable v2 bundle | `codex_app_server_protocol.v2.schemas.json` |
| Stable v2 bundle SHA-256 | `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9` |
| Release tag | [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0) |
| Release source commit | [`758ef40`](https://github.com/openai/codex/commit/758ef40) |

The schema was generated twice into separate empty temporary directories and
the two stable v2 bundles were byte-identical. No `--experimental` flag was
used. The binary digest is evidence for the inspected macOS arm64 artifact,
not a cross-platform digest. The schema bundle digest is the protocol pin.

The current web documentation can describe a later release. For example, its
sample `initialized` notification includes `params: {}`, while the generated
0.149.0 `ClientNotification` schema permits only the `method` field. For this
adapter, the generated 0.149.0 schema wins whenever current prose and the
pinned artifact differ.

## Decision

| Area | Accepted preview choice |
| --- | --- |
| Interface | Stable Codex App Server v2 surface from CLI `0.149.0` |
| Schema | Generated stable bundle SHA-256 `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`; pinned schema wins over current prose |
| Launch | One direct child per provider invocation: `codex app-server --listen stdio:// --strict-config`; JSONL stdio; no shell, daemon, proxy, socket, or WebSocket |
| Conversation identity | `thread.id` is the provider session ID; `turn.id` is the exact recovery handle |
| Input | One structured text item on stdin after durable session publication; never argv, environment, file, config, skill, or mention input |
| Local authority | Thread start and resume use coarse read-only; turn start maps the local connector maximum to exact read-only or one-root workspace-write with network disabled |
| Approvals | Policy `never`, reviewer `user`; three exact unexpected approval request methods become content-free safe waits; no response or grant |
| Recovery | Stable `thread/read` with the exact thread and non-null turn IDs; no session-only recovery or turn replay |
| Auth and history | Use existing Codex-owned auth and persistent history; copy, inspect, and retire neither |
| Platforms | Preview candidates are Linux x64, macOS arm64, and macOS x64; Windows remains deferred |
| Containment | Attach the real child to the provider-owned hook; stdio owner death remains unproven until CX04 |
| Distribution | External Apache-2.0 Codex installation; no bundled binary, new dependency, public package, or stable-support claim |

### Version and compatibility

Select Codex CLI and App Server release `0.149.0` exactly. Do not accept a
range, prerelease, or later compatible-looking version. The connector does not
install or update Codex. Version stdout and a stable file identity do not prove
that a same-version local binary is byte-identical to an official release. The
preview accepts that residual local-installation trust only after CX04 verifies
the generated schema digest and the complete real-provider behavior matrix.
The inspected macOS arm64 digest is evidence, not a cross-platform allowlist.

When the connector constructs the adapter and before it binds the listener, the
adapter resolves the literal executable name `codex` once through the already
scrubbed provider `PATH`, resolves the result to a canonical executable file,
and pins its canonical path plus POSIX device, inode, size, modification time,
change time, and executable mode for the connector process. Failure records an
unavailable adapter but adds no new startup error or output. This is a single
normal command lookup, not a filesystem scan or runtime discovery feature. A
symlink supplied by a normal Codex installation may be resolved, but the
canonical target and pinned identity must not change during the run.

The preflight runs the canonical executable once with the one argument
`--version`, `shell: false`, the canonical working directory, and the scrubbed
provider environment. It has a 5-second monotonic deadline and captures at most
64 stdout bytes and 1,024 stderr bytes. Stdout must be exactly
`codex-cli 0.149.0\n`. Stderr is discarded and is never reflected. The version
probe is attached to the provider containment hook and must be empty before the
listener binds. Before every provider-port invocation, the adapter revalidates
the pinned canonical path and file identity without another version process.
A missing executable, unavailable startup resolution, different version,
changed identity, probe overflow, timeout, or execution failure records an
unavailable adapter after cleanup and later emits the safe pre-turn
`failed/provider_start_failed` result without starting App Server or submitting
input. Unproven probe cleanup fails startup with the existing fixed
`connector_shutdown_incomplete` error and never binds the listener. Neither
path triggers installation, login, or fallback.

CX02 checks in the generated stable v2 schema bundle as a test-only Apache-2.0
fixture with its digest and source notice. Production code uses closed Zod
schemas for the accepted subset and adds no JSON Schema validator dependency.
CX04 regenerates the stable bundle from the real executable and requires the
exact digest before real-provider qualification.

The adapter initializes with `experimentalApi: false` and never sends an
experimental method or field. It accepts no schema negotiation, capability
probe, older protocol, compatibility alias, or unknown method. Updating Codex
requires a new CX01 amendment that pins the new release and schema digest,
reviews the complete selected-schema diff, advances CX02 first, and repeats
real qualification. An automatic Codex update therefore makes startup fail
closed until that review completes.

### Launch and transport

Each `start`, `resume`, or `recover` provider-port invocation owns one fresh
App Server process. Processes are not shared between A2A turns or
conversations. The exact child argument vector is:

```text
<canonical-codex-path> app-server --listen stdio:// --strict-config
```

The child is launched directly with `shell: false`, its working directory is
the canonical directory accepted by ADR 0028, and its environment is the
provider-child allowlist from ADR 0028. The adapter adds no environment name.
It does not start the App Server daemon, proxy, WebSocket, or Unix-socket
transport.

App Server stdin and stdout carry bidirectional newline-delimited JSON. The
wire format is the documented JSON-RPC 2.0 shape with the `jsonrpc` member
omitted. Connector requests use positive safe-integer IDs that are unique and
monotonic within one child. A response must match exactly one outstanding
request. Server notifications have no ID. Server-initiated requests have an
ID and are handled only as described under approvals.

The adapter writes one compact JSON object and one LF per message. It accepts
one UTF-8 JSON object per LF-terminated stdout record. Empty records, an
unterminated final record, invalid UTF-8, duplicate JSON keys, non-objects,
invalid envelopes, batches, and trailing non-whitespace bytes fail the raw
protocol. One record is limited to 1,048,576 bytes excluding its LF, and JSON
nesting is limited to 100 container levels. These are the provider-specific
raw bounds required by ADR 0030. The common 8 MiB stdout and 8 MiB stderr
limits still apply to the complete turn.

Stderr is never parsed as protocol, logged, or reflected. It is drained inside
the common bound and discarded after the invocation.

### Handshake

Immediately after launch, send one `initialize` request. Its closed parameter
record is:

```json
{
  "clientInfo": {
    "name": "a2a_codex_connector",
    "title": "A2A Codex Connector",
    "version": "<connector-package-version>"
  },
  "capabilities": {
    "experimentalApi": false,
    "requestAttestation": false,
    "optOutNotificationMethods": ["configWarning"],
    "extensions": null
  }
}
```

After the exact successful response, send the 0.149.0 notification
`{"method":"initialized"}`. Send no request before this sequence completes.
Before the adapter writes `initialized`, the only accepted server message is
the exact successful response to `initialize`. Any notification,
server-initiated request, wrong response ID, error, timeout, malformed result,
or process exit during that phase is a pre-provider failure and submits no A2A
input. Only after `initialized` is written may the bounded allowlisted
notifications below be accepted.

`configWarning` is the only notification opt-out. It is declared in the
initialize request before `initialized`; receiving it despite that exact
opt-out is a protocol failure. The adapter accepts and discards other
allowlisted warning notifications under the bounded ignored-notification rule
below. It does not suppress lifecycle, item, turn, or approval messages.

The adapter does not use account, model, configuration, plugin, filesystem,
login, logout, token refresh, dynamic-tool, thread fork, rollback, archive,
delete, or shell-command methods.

### Fixed local settings

The adapter never lets A2A data select a model, service tier, personality,
reasoning effort, instructions, tool, skill, app, MCP server, provider path,
thread, working directory, sandbox, approval policy, or environment field.
Those fields are omitted unless this record fixes them.

For a new provider session, `thread/start` contains exactly:

- `cwd`: the canonical ADR 0028 working directory;
- `approvalPolicy`: `never`;
- `approvalsReviewer`: `user`;
- `sandbox`: the exact 0.149.0 value `read-only`, regardless of the connector
  maximum;
- `ephemeral`: `false`; and
- `serviceName`: `a2a_codex_connector`.

All other optional fields are absent. In particular, the adapter supplies no
model, base instructions, developer instructions, config override, or dynamic
tool. It validates that the response reports the same canonical directory,
the `never` approval policy, the `user` reviewer, and the exact read-only
sandbox. Starting a thread with workspace-write is forbidden because Codex can
persist project-trust state during thread creation.

For a mapped conversation, `thread/resume` sends only the exact stored
`threadId` plus the same `cwd`, `approvalPolicy`, `approvalsReviewer`, and
coarse `sandbox` values. It requires the returned `thread.id` to match byte for
byte and again requires the exact read-only sandbox. It does not resume from a
path or caller-supplied history.

Every `turn/start` sends exactly one input item:

```json
{
  "type": "text",
  "text": "<input_text>",
  "text_elements": []
}
```

The text comes only from the provider port's validated `input_text`. It is
written to App Server stdin after the durable session barrier. It never enters
argv, the child environment, a temporary file, a generated script, a config
override, a skill or mention item, or connector state.

The turn request repeats the exact thread ID and canonical `cwd`, sets
`approvalPolicy: "never"` and `approvalsReviewer: "user"`, and supplies one of
these exact 0.149.0 stable sandbox policies:

| Connector maximum | App Server `sandboxPolicy` |
| --- | --- |
| `read-only` | `{"type":"readOnly","networkAccess":false}` |
| `workspace-write` | `{"type":"workspaceWrite","writableRoots":["<canonical-working-directory>"],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true}` |

No request selects `danger-full-access`, `dangerFullAccess`, external sandbox,
automatic review, session approval, network access, another writable root, or
another working directory. A managed Codex policy may narrow effective access.
If Codex cannot represent the selected maximum without widening it, the
adapter fails before `turn/start`.

The stable `turn/start` response exposes the turn but not its effective sandbox
or persisted configuration. CX02 therefore separates evidence: fake-protocol
tests prove the exact outbound omissions and policies, and response tests prove
only fields that 0.149.0 actually reports. CX04 must then run behavioral
read-only, one-root write, out-of-root denial, and network-denial probes. Its
external harness snapshots the existing user `~/.codex/config.toml` before and
after start, resume, and both policy modes and requires identical existence and
bytes. The adapter itself never reads that file. Provider history and auth
artifacts are outside this config snapshot and remain under their separate
boundaries.

### Session and turn binding

`thread.id` is the common provider session ID. The first valid matching
`thread/started` notification or `thread/start` response may supply it. The
adapter emits one `session_bound` event and then waits for the connector to
request the next provider event. The connector therefore publishes the
encrypted thread mapping before the adapter sends `turn/start`. The later
response and notification must report the same ID; a mismatch is a contract
failure.

`turn.id` is the common provider turn ID. The first valid matching
`turn/started` notification or `turn/start` response may supply it. The adapter
buffers any event for that turn until it emits one `turn_bound` event. The
later response or notification must report the same ID. No duplicate binding
is emitted.

App Server may begin work before either `turn/started` or the `turn/start`
response reaches the adapter. `turn_bound` is therefore a durable recovery
handle, not a pre-execution barrier. A crash after `turn/start` is written but
before the turn ID is durable remains uncertain. The adapter does not use
session-only recovery and never submits the input again.

On `resume`, `thread/resume` is a non-turn preflight. Only after it returns the
exact stored thread and settings does the adapter send one `turn/start`. It
never creates a replacement thread when resume or turn creation is missing,
ambiguous, or invalid.

### Event normalization and final result

The adapter validates every control message against a closed schema derived
from the pinned stable bundle. A thread- or turn-scoped message for another ID
is a contract failure. The fixed 0.149.0 stable notification-method allowlist is
compiled into the adapter and admits non-authoritative item, tool, reasoning,
plan, diff, token-usage, status, non-config warning, and rate-limit
notifications. `configWarning` is excluded because the handshake opts out of
it. For those ignored notifications, the adapter validates the envelope,
requires an object payload, checks any `threadId` or `turnId` against the active
invocation, counts the record against all common limits, and discards the
remaining fields without interpretation or logging. This permits the user's
existing Codex tools and MCP servers to stream provider-owned detail without
turning it into connector state or output. A method absent from the fixed
stable allowlist, an unknown field in a selected control record, or a malformed
selected event fails the invocation.

The selected mapping is:

| App Server observation | Provider-neutral event |
| --- | --- |
| First accepted `thread.id` for `start` | `session_bound` |
| First accepted `turn.id` | `turn_bound` |
| Nonempty matching `item/agentMessage/delta` | `progress` with the exact delta |
| Matching supported server approval request | `approval_required` |
| `turn/completed` with status `completed` and one valid final agent message | `reply` with the exact final text |
| `turn/completed` with status `failed` for an exact bound turn | `failed/provider_execution_failed` |
| A malformed, empty, ambiguous, or over-limit final result for an exact terminal turn | `failed/provider_result_invalid` |
| A turn that may have executed but has no exact terminal result | `uncertain/provider_outcome_unknown` |

The `turn/completed` turn snapshot is authoritative for the terminal result.
Its `itemsView` must be `full`. Select exactly one nonempty `agentMessage` whose
phase is `final_answer`. If no such item exists, accept exactly one nonempty
phase-null `agentMessage` as the 0.149.0 compatibility case. Commentary is
never the reply. A prior `item/completed` for the same item is corroborating
evidence and must match the terminal snapshot byte for byte. Multiple candidate
final messages, no candidate, a completed-item mismatch, a delta inconsistent
with the same completed item, invalid Unicode, or an over-limit value is
`provider_result_invalid`. The adapter never reconstructs a reply from deltas.

The adapter does not emit `completed_without_reply`, `unsupported`, or a safe
cancelled result for a Codex turn. A pre-turn process, handshake, or
`thread/start` failure with positive evidence that `turn/start` was never sent
may emit `failed/provider_start_failed`. Once `turn/start` bytes may have been
written, a transport error, JSON-RPC error, EOF, process exit, or missing turn
ID maps to uncertainty unless exact recovery supplies the terminal result.

### Terminal teardown

The adapter does not emit any terminal provider event while its App Server
unit can still execute. It first validates and holds the candidate terminal
event, closes App Server stdin, continues bounded stdout and stderr draining,
and waits up to 1 second for the exact child and its owned execution unit to
become empty and for the child to be reaped. A later conflicting control record
invalidates the held terminal result.

If the unit is not empty after 1 second, the adapter invokes the exact
provider-owned containment hook. The unit must be empty and the child reaped by
3 seconds from the initial stdin close. Only then may the adapter emit the held
`reply`, `failed`, `cancelled`, `completed_without_reply`, or `uncertain` event.
This adapter does not normally produce the last two event kinds, but the rule
applies to every provider terminal shape.

Failure to prove an empty unit within that one 3-second cleanup budget closes
the stream with a typed containment failure and emits no terminal provider
event. The common connector then preserves the dispatch-sensitive uncertain
state and applies its process-terminal containment failure behavior. Normal
terminal teardown does not add the 10-second cancellation grace, extend the
durable turn deadline, or identify a process by name, command line, or guessed
PID.

### Approvals and interactive requests

The first adapter intentionally narrows Codex to `approvalPolicy: "never"` and
keeps `approvalsReviewer: "user"`. It never selects `auto_review` or
`guardian_subagent`, sends an accept or grant response, amends policy, or
creates a connector approval surface.

The complete supported server-request set is:

| Method | Required scope | Adapter action |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | Exact active thread and turn | Emit `approval_required`; send no response |
| `item/fileChange/requestApproval` | Exact active thread and turn | Emit `approval_required`; send no response |
| `item/permissions/requestApproval` | Exact active thread and turn | Emit `approval_required`; send no response |

If 0.149.0 nevertheless sends one of those requests, the adapter converts the
typed JSON-RPC request ID to a collision-free opaque string. Numeric request
IDs become `n:<canonical-safe-integer>`; string request IDs become
`s:<exact-string>`, so the two wire types cannot collide. The encoded value
must meet the common 1-to-1,024-byte provider-ID bound. Request detail remains
in bounded memory and never enters the normalized event, connector state, logs,
or diagnostics.

The 0.149.0 `serverRequest/resolved` notification does not carry the decision.
It cannot produce `approval_resolved`. A waiting turn therefore remains open
until the absolute connector deadline causes an interrupt. An independently
resolved request or terminal event before connector-initiated cancellation is
an invalid approval sequence and follows the contract-failure path.

Every other 0.149.0 server-request method, including MCP elicitation, tool user
input, a dynamic tool, token refresh, attestation, and legacy approval methods,
is unsupported. The adapter sends no response and uses the common
dispatch-sensitive failure or uncertainty path.

This is deliberately less capable than an interactive Codex client. A future
approval mechanism requires a new decision and must still comply with ADR
0030's ban on connector-owned approval controls and automatic grants.

### Cancellation

With an exact live thread and turn ID, provider-port `cancel` sends one
`turn/interrupt` request for those IDs. The request is bounded by the remaining
absolute grace from ADR 0030. Writing the request yields
`cancel_requested`; an invocation already known terminal yields
`already_terminal`; an invocation with no live child or no exact turn handle
yields `not_found`. None of these statuses proves that execution stopped.

After interrupt, the adapter keeps draining bounded output. A matching
`turn/completed` with status `interrupted` is exact interruption evidence, but
this adapter does not claim that earlier stateful work was absent. It therefore
maps the terminal result to uncertainty unless a later reviewed version adds
and proves the positive evidence required by ADR 0030. A slow or malformed
interrupt response never extends the deadline or grace.

At grace expiry, shutdown, output overflow, protocol failure, or state failure,
the adapter hands the exact child to the provider-specific containment path.
It never guesses another process by name, command line, PID, working directory,
or provider state.

### Exact-turn recovery

Recovery with a non-null stored turn ID starts a fresh pinned App Server,
completes the stable handshake, and calls only stable
`thread/read` with the exact stored thread ID and `includeTurns: true`. It does
not call `turn/start`, `turn/steer`, `thread/fork`, or another creating method.

The response must contain the same thread ID and exactly one full-view turn with
the stored turn ID. A completed turn is normalized from its authoritative
stored items using the same final-reply rule. A failed exact turn produces
`failed/provider_execution_failed`. An interrupted, still-in-progress,
missing, duplicate, malformed, oversized, or ambiguous turn produces
`uncertain/provider_outcome_unknown`. Recovery never returns output from a
different turn.

Recovery with `provider_turn_id: null` makes no App Server request and emits
`uncertain/provider_outcome_unknown` first. Codex 0.149.0 has no accepted
non-creating selector that proves which unbound latest turn belongs to the
inbound message. This explicitly leaves ADR 0030's session-only recovery path
unqualified.

`thread/read` can return provider-owned historical content. It remains in
bounded memory only, is scanned only for the exact turn, and is discarded
after normalization. A history response that exceeds the raw line, stdout,
nesting, event, or reply bound fails closed to uncertainty.

### History and retention

`ephemeral` is false because multi-turn resume and exact-turn recovery require
Codex-owned persisted history. Codex may retain prompts, agent messages, tool
calls, tool results, and other thread items in its own state. The connector
stores only the encrypted opaque thread and turn IDs permitted by ADR 0029.

The adapter never copies, indexes, archives, compacts, deletes, exports, or
rewrites Codex history. Connector `retire-state` does not remove provider
history or credentials. Setup documentation must disclose that separation and
direct users to Codex's own history controls. If the user deletes, archives,
moves, corrupts, or makes the exact history unavailable, the adapter reports
uncertainty and never starts a replacement turn.

The first Codex adapter has no one-shot or no-history mode. Such a mode could
not claim multi-turn continuity and needs a separate decision.

### Authentication boundary

The user installs and authenticates Codex through Codex's normal mechanism.
The connector inherits only ADR 0028's scrubbed child environment, including
`HOME` when present. It does not add `CODEX_HOME`, `OPENAI_API_KEY`, another
credential-shaped environment field, a token argument, or an auth file copy.

The adapter never calls App Server login, logout, account, token refresh, or
external-token methods. It does not read Codex credential files. App Server
may access its existing provider-owned authentication under the inherited
account home. Missing or invalid authentication produces only the fixed common
provider failure or uncertainty behavior, with no credential recovery or
replacement.

CI uses a fake App Server and contains no Codex or OpenAI credential. Real
qualification is manual and opt-in with an existing authenticated
installation.

### Containment and supported platforms

The Codex adapter owns the App Server process and every local execution it
starts. One invocation has one root App Server process. It must attach K03's
provider-neutral cancellation, output, and containment hooks to this real
launch path.

The selected owner-death candidate is the stdio lifetime itself: the child has
one connector-owned stdin pipe and no daemon, proxy, socket, or alternate
client. Connector death closes that pipe. The pinned App Server must then exit
and terminate every execution it owns. This behavior is not treated as proven
by documentation or by the CX01 spike. CX04 must hard-kill the connector while
the real App Server has a root command and descendant active, then prove the
whole unit is empty without a name or PID scan. Graceful EOF or a direct-child
exit alone is insufficient.

The candidate platform matrix is Linux x64, macOS arm64, and macOS x64, matching
ADR 0031. CX02 runs the fake protocol on Linux and macOS. A real
provider/platform pair becomes supported only after the packed connector,
exact Codex 0.149.0 binary, policy, interruption, hard-crash containment,
recovery, and artifact tests pass there. Failure of the stdio owner-death
candidate leaves that pair unsupported and returns the containment mechanism
for a new dependency and platform decision.

Windows remains unsupported and deferred under ADR 0033. This record adds no
Windows job, artifact, setup path, or support claim.

### License, packaging, and updates

Codex CLI and App Server are external OpenAI software licensed under
[Apache-2.0](https://github.com/openai/codex/blob/rust-v0.149.0/LICENSE). The
connector remains MIT-licensed. It does not redistribute Codex, link a Codex
SDK, add a runtime dependency, or include the Codex binary or generated schema
in a staged provider package. The schema fixture and its source notice are
test-only.

Users install, authenticate, update, and remove Codex themselves. The
connector does not run an installer, package manager, login flow, self-update,
or background update service. Release 0.149.0 is the only accepted version.
The official documentation currently describes the App Server command as
experimental and unsupported for production workloads. Consequently this
decision can support only the user-approved Codex-first preview path. It does
not satisfy Q05 stable publication or a production support claim.

## CX02 red specification plan

CX02 adds a full-process fake App Server, test-only pinned schemas, and a
classified expected-red inventory before production adapter code. The fake is
selected only through a private test seam. No public CLI, environment option,
provider executable selector, package dependency, or staged control is added.

| ID | Red case | Required observation |
| --- | --- | --- |
| X01 | Resolve no executable; hang, overflow, or fail the version probe; change the canonical target or pinned identity; or report a wrong, prerelease, or later version | Bind only after proven probe cleanup, admit no provider input, emit only the safe pre-turn failure, and never install or fall back |
| X02 | Inspect the real provider launch record | Exact canonical executable, exact four App Server arguments, `shell:false`, canonical cwd, scrubbed environment, no input in argv or environment |
| X03 | Verify the checked-in test-only stable schema fixture and its source notice | Exact 0.149.0 stable bundle hash; no experimental bundle or production package file |
| X04 | Send a valid handshake and each early, missing, duplicate, wrong-ID, error, timeout, and malformed variant; send allowed warnings and `configWarning` before and after initialized | Before initialized, only the exact initialize response succeeds; afterward allowlisted non-config warnings may be discarded; the opted-out warning always fails |
| X05 | Start a new conversation with response-first and notification-first thread binding | Emit one session binding, persist it before `turn/start`, and require the later source to match |
| X06 | Crash before and after session publication and before `turn/start` | No input before the durable session barrier; restart never creates a second thread or turn |
| X07 | Resume one stored thread and return a missing, different, malformed, or broader-policy thread | Use only the stored ID and sealed settings; never create a replacement thread |
| X08a | Inspect every outbound start, resume, and turn request under both connector policies and keep a fake provider-config sentinel | Start and resume use coarse read-only; turn alone uses the exact policy; every model, instruction, tool, skill, app, MCP, config, environment, and broader-authority field is absent; fake config is byte-identical |
| X08b | Return each observable exact, missing, malformed, mismatched, or broader thread/start, thread/resume, and turn/start response field | Validate only fields 0.149.0 reports; require exact thread, cwd, approval policy, reviewer, and read-only thread sandbox; never invent response evidence for the turn sandbox |
| X09 | Put commands, flags, paths, JSON, skill syntax, mentions, policy names, and environment assignments in A2A text | Preserve all bytes only in the one text input item; change no execution setting |
| X10 | Deliver turn response before notification, notification before response, matching duplicates, mismatches, output before binding, and a crash before binding | Emit one turn binding when exact; buffer matching output; mismatch or unbound crash becomes uncertainty with no replay |
| X11 | Stream exact nonempty agent deltas, completed agent-message items, and the terminal full turn snapshot | Normalize deltas as progress and only the authoritative terminal snapshot as one exact reply; require corroborating items to match |
| X12 | Return commentary, one final answer, phase-null compatibility, empty, multiple, conflicting, malformed, and over-limit candidates | Reply only for the accepted single candidate; exact terminal invalidity maps to `provider_result_invalid` |
| X13 | Complete a turn as failed, interrupted, EOF, process crash, JSON-RPC error, or without a terminal | Definite failure only for an exact failed turn; all potentially executed unknowns become uncertainty |
| X14 | Send each supported approval or interactive request with numeric and string request IDs | Emit one content-free approval ID, send no response or grant, publish the common waiting state, and retain no detail |
| X15 | Resolve an approval without a decision, repeat or mismatch it, or send MCP elicitation, tool-input, dynamic-tool, auth-refresh, attestation, or legacy client-capability requests | Never invent `approval_resolved`; reject unsupported controls and grant nothing |
| X16 | Cancel before a turn ID, during a bound turn, while waiting, after terminal, and with slow, malformed, or mismatched interrupt results | Send only exact `turn/interrupt` when bound, never extend grace, and make no safe-cancellation claim without proof |
| X17 | Recover an exact completed, failed, interrupted, in-progress, missing, duplicate, or wrong-thread turn through `thread/read` | Return only the exact stored terminal result; every ambiguous case is uncertain and starts no work |
| X18 | Recover with a null turn ID | Make no App Server request and emit uncertainty first |
| X19 | Supply a large history containing other prompts, replies, tools, credentials, and approval detail | Inspect only bounded memory for the exact turn; persist and log none of it |
| X20 | Send invalid UTF-8, duplicate JSON keys, arrays, batches, unknown methods or fields, an unterminated line, 1 MiB and one-over records, and depth 100 and 101 | Accept exact raw boundaries and fail closed on every excess before normalization |
| X21 | Reach the common event, stdout, stderr, progress, ID, and reply limits through valid App Server envelopes | Preserve every ADR 0030 exact boundary and cancellation or uncertainty result |
| X22 | Drop or mutate the stored thread history between turns | Never create a replacement session or turn; return uncertainty or the fixed provider failure permitted before dispatch |
| X23 | Scan state, logs, diagnostics, argv, environment, temp paths, crashes, staged files, and packed files | Find no A2A text, reply, tool data, approval detail, Codex auth, schema fixture, or sender-controlled setting |
| X24 | Hard-kill the connector with fake App Server root and descendants active on Linux and macOS | Exercise the real adapter attachment to the foundation containment hook; do not claim real Codex containment |
| X25 | Run the complete fake App Server chain for two turns in one thread and two concurrent conversations | Preserve exact thread resume, common concurrency, reply-before-ack, and one terminal provider result per turn |
| X26 | Load a partial or malformed production adapter module | Fail as an unreviewed defect; only exact absence of the CX03 module may carry the reviewed-red marker |
| X27 | Hold each terminal shape while App Server exits normally, lingers, spawns a descendant, emits a conflicting late control, or resists containment | Close stdin first, reap and prove the exact unit empty within the fixed 3-second budget, and emit no terminal provider event before that proof |

CX02 keeps normal repository tests green and adds its classified inventory to
the existing red-inventory runner on Linux and macOS. The inventory must name
every top-level node and distinguish missing CX03 production behavior from a
fixture, schema, or runner defect. CX02 must not invoke a real Codex binary or
read the user's Codex home.

CX04 owns X08c because the fake protocol cannot prove a real sandbox. On each
candidate platform, X08c runs harmless read-only, allowed one-root write,
out-of-root write, and network probes through the packed connector. It requires
the first two to follow the selected local policy, the latter two to be denied,
and the external before-and-after snapshot of `~/.codex/config.toml` to keep
identical existence and bytes. This is behavioral qualification, not a CX02
red node or a provider config read by the adapter.

## Alternatives

- **Codex SDK.** It is better suited to job automation, but the selected App
  Server surface exposes the thread, turn, event, approval, and history
  primitives required by the existing provider port. Selecting the SDK would
  need its own exact dependency and recovery review.
- **Codex exec mode.** It is simpler for one-shot work but does not provide the
  accepted structured multi-turn and exact-turn protocol.
- **App Server WebSocket or Unix socket.** These add listener authentication,
  endpoint, shared-daemon, and cross-turn ownership concerns. Stdio gives one
  connector-owned process and one bounded stream.
- **App Server daemon or proxy.** A shared background process weakens
  per-invocation cancellation and hard-crash ownership and conflicts with the
  foreground, no-service boundary.
- **Accept the latest Codex release.** The official schema is generated per
  version. A range would turn an update into an unreviewed protocol and policy
  change.
- **Automatically approve or use an automatic reviewer.** This would grant
  local authority without the provider-owned, user-reviewed interface required
  by ADR 0030.
- **Start a replacement turn after missing history.** This can repeat file and
  external effects and is forbidden by the common uncertainty contract.

## Costs and risks

Exact pinning is operationally strict. A normal Codex update disables the
adapter until its schema and behavior are reviewed. Stable `thread/resume` and
`thread/read` return stored turns rather than a narrow exact-turn result, so
long histories may exceed the raw output bound and become uncertain.

The `never` approval policy makes unattended behavior safe but prevents work
that needs a user grant. Provider-owned history remains content-bearing and
outlives connector retirement. The App Server command is experimental, and
the selected stdio owner-death containment candidate has not yet passed
real-provider qualification. These constraints are acceptable only for the
preview path.

## Approval

Accepted on 2026-08-30 for the Codex-first preview implementation path. The
user authorized the team to make new design decisions using its best judgment,
record them for later review, and proceed. CX02 may add the fake App Server,
test-only schema fixture, and reviewed-red adapter specification. After CX02's
failure review, CX03 may implement this adapter against the already accepted
provider port.

The recorded decisions remain available for user review, but that review is
not a blocker for CX02 or CX03. This acceptance does not authorize a new
dependency, CLI change, public package, real-provider CI, publication, stable
support, real-central compatibility claim, or Windows support.
