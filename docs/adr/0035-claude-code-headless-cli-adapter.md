# 0035 Claude Code headless CLI adapter

Status: superseded by ADR 0038; historical reference only

Date: 2026-08-31

Approval: approved by the user on 2026-08-31

## Problem

ADRs 0024 and 0028 through 0031 define a provider-neutral connector, but they
do not select a Claude interface. CL01 must choose one exact Claude Code or
Claude Agent SDK release and fix its input, session, policy, history,
recovery, cancellation, containment, license, and update contracts before
CL02 writes the fake-provider specification.

The selected interface must keep A2A input out of process arguments,
environment variables, settings, files, and connector state. It must use an
existing provider installation without copying credentials. It must also
preserve the common rule that a connector never starts a replacement turn
when the exact prior outcome is unknown.

The primary sources for this decision are Anthropic's official
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[programmatic-use guide](https://code.claude.com/docs/en/headless),
[permissions guide](https://code.claude.com/docs/en/permissions),
[settings reference](https://code.claude.com/docs/en/settings),
[authentication guide](https://code.claude.com/docs/en/authentication), and
[legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance).
The exact selected release is the official
[Claude Code 2.1.251 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.251).
The rejected SDK comparison uses the official
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
and [0.3.251 package metadata](https://www.npmjs.com/package/%40anthropic-ai/claude-agent-sdk?activeTab=versions).
The history decision uses Anthropic's
[session documentation](https://code.claude.com/docs/en/sessions).

## Decision

Select the separately installed official Claude Code headless CLI at exactly
version `2.1.251`. Do not select the Claude Agent SDK.

| Area | Accepted choice |
| --- | --- |
| Interface | Claude Code `-p` with stream-JSON stdin and stdout |
| Version | Exactly `2.1.251`; no range, prerelease, fallback, or compatibility probe |
| Installation | User-managed official installation; connector does not install, update, remove, or authenticate it |
| Dependency | No SDK, provider package, runtime dependency, lockfile change, or bundled provider binary |
| Process | Connector directly spawns one packaged Node lifetime monitor as a detached POSIX process-group leader; that monitor alone spawns one `claude` child into its group per provider-port invocation |
| Session | Caller-generated UUIDv4 passed through `--session-id`; exact stored ID passed through `--resume` |
| Input | One `SDKUserMessage` JSONL record on stdin after durable session publication; never argv, environment, settings, or a file |
| Output | Closed stream-JSON subset ending in one matching terminal `result` record |
| Policy | `--restricted`, `--safe-mode`, `dontAsk`, fixed tool availability, no approval grant |
| Recovery | No provider turn ID and no exact-turn recovery; uncertain work is never resumed or replayed |
| History | Claude owns its persistent session history; the connector never reads, copies, searches, changes, or deletes it |
| Platforms | Qualification candidates are Linux x64, macOS arm64, and macOS x64; Windows remains deferred |
| Containment | One connector-known monitor-led POSIX process group, one zero-byte owner pipe, and two bounded content-free control pipes that remain open after prompt EOF; every terminal path kills that exact group, a living connector proves it empty, and hard-death qualification proves the orphaned unit disappears; real monitor behavior remains unproven until CL04 |
| License | External Anthropic software under the applicable Anthropic Consumer or Commercial Terms; no redistribution |

### Why the CLI is selected

The TypeScript Agent SDK release considered by CL01 was
`@anthropic-ai/claude-agent-sdk@0.3.251`. It would add a production package and
a bundled native Claude Code binary. Anthropic's Agent SDK documentation tells
third-party products to use an API key or an approved cloud provider rather
than offer or route a user's Claude subscription login. That authentication
model conflicts with the connector's existing-install boundary and its
credential-stripped child environment.

The SDK's ordinary `query()` flow sends input before it returns the
`system/init` session record. Its streaming-input form does not document that
the session record arrives before the first input is pulled. The SDK also
offers content-bearing session-list and message-reading APIs, but this project
forbids the connector from inspecting provider history. Resume and
`resumeSessionAt` start provider work. They do not provide an authoritative,
non-creating lookup of the exact prior result.

The headless CLI keeps authentication inside the user's official Claude Code
installation, supports a caller-supplied session UUID, resumes an exact
session ID, and accepts structured input through stdin. It adds no repository
dependency. Its two remaining protocol gaps are explicit CL04 qualification
gates rather than assumptions hidden in production code.

### Version and executable preflight

Select Claude Code `2.1.251` exactly. Release `2.1.251` is the first reviewed
release after `--restricted` became available in `2.1.248`, and its release
notes include fixes to stream-JSON input and file-tool path containment. A
later installed version is not treated as compatible.

Before the connector binds its webhook listener, the Claude adapter factory
resolves the literal executable name `claude` once through the scrubbed
provider `PATH`. It resolves the result to a canonical executable file and
pins the path plus its POSIX device, inode, size, modification time, change
time, and executable mode for the connector process. This is one normal
command lookup, not runtime discovery or a configurable provider selector.

The preflight uses the same packaged lifetime monitor as a provider turn. The
connector directly invokes `process.execPath` with the packaged monitor module
as its only argument, `shell: false`, the canonical working directory, and the
scrubbed provider environment. After the monitor reports ready, its fixed
start command names the canonical Claude executable and the one argument
`--version`. The adapter applies a five-second monotonic deadline and captures
at most 64 stdout bytes and 1,024 stderr bytes from the monitor's pass-through
streams. The accepted CL02 fixture output is exactly:

```text
2.1.251 (Claude Code)
```

The public CLI documentation does not specify the byte-exact version stdout.
CL04 must confirm this value against the official native executable before a
platform can qualify. A different real value requires an ADR amendment and a
CL02-first contract change. Production does not accept multiple spellings.

The connector holds the version result until it has sealed the monitor-led
group, reaped its direct monitor child, and proved the exact group empty. It
does this before it binds the listener. Before every provider invocation, the
adapter revalidates the pinned path and file identity without starting another
version process. A missing executable, wrong version, changed identity,
overflow, timeout, signal, monitor fault, or execution failure records an
unavailable adapter after the same cleanup. A later provider call emits only
`failed/provider_start_failed` before submitting input. Unproven group cleanup
fails startup with the existing content-free
`connector_shutdown_incomplete` error.

The connector never runs an installer, package manager, login command,
`claude setup-token`, updater, or authentication-status command. It does not
read Claude's credential files or macOS Keychain entries.

### Lifetime monitor and fixed launch

Each `start` or `resume` invocation owns one fresh packaged Node lifetime
monitor and one fresh Claude child. Processes are not shared between turns or
conversations. `recover` starts neither process under this contract. The
monitor uses only the already approved Node runtime and Node core modules. It
adds no package, executable, native helper, service, or public interface.

The connector starts the monitor directly with this exact vector:

```text
<process.execPath> <packaged-claude-lifetime-monitor-module>
```

The packaged module is the regular
`dist/claude-connector/src/claude-lifetime-monitor.js` file resolved relative
to the running adapter module. The connector invokes it with `shell: false`,
`detached: true`, the canonical working directory, and the scrubbed provider
environment. On supported POSIX platforms, the positive monitor PID is the
process-group ID. The connector obtains that PID from its direct spawn handle
and records it as the exact group ID before it may write a start command. The
group exists before Claude can spawn, so there is no unpublished child-group
interval.

The monitor launch passes no A2A text, provider reply, provider executable
path, session ID, policy, settings, or credential in argv or added
environment. Its exact `stdio` value is six `pipe` entries. Descriptors 0
through 2 carry provider data. Descriptor 3 carries owner lifetime only.
Descriptor 4 carries commands to the monitor, and descriptor 5 carries
lifecycle records back.

Monitor stdin, stdout, and stderr are the provider data streams. The connector
writes prompt JSONL to monitor stdin. The monitor forwards those bytes with
backpressure to Claude stdin and writes no copy. It forwards Claude stdout and
stderr bytes with backpressure to its own stdout and stderr. It does not parse,
log, persist, diagnose, or reflect content. The adapter applies every ADR 0030
bound to the pass-through streams.

The connector uses three extra one-way pipes. Descriptor 3 is the owner pipe
from connector to monitor. It carries zero bytes. The connector keeps its
write end open for the monitor's complete lifetime, including after prompt
stdin closes. Descriptor 4 carries connector-to-monitor commands. Descriptor
5 carries monitor-to-connector lifecycle records. Both control pipes stay
open until group sealing or owner death. They are separate from all three
provider data streams. No normal path closes the owner pipe to release a live
monitor.

Descriptors 4 and 5 use strict UTF-8 JSONL objects with unique keys, no
trailing bytes, at most 16,384 bytes per record excluding LF, at most 16
container levels, at most 32 records in each direction, and at most 65,536
bytes in each direction. Control may carry only canonical paths, fixed Claude
arguments, opaque provider IDs, integer process data, null exit fields, and
fixed control names or error codes. It never carries A2A input, provider
output, tool data, approval detail, credentials, or provider history.

As its first application action, the monitor opens descriptor 3 for reading
and arms its EOF, close, and error paths. It opens descriptors 4 and 5 and
arms their close, error, parse-failure, uncaught-exception, and
unhandled-rejection paths. It installs SIGINT and SIGTERM handlers and child
and stream error handling. It pauses stdin so it cannot retain provider bytes
before a Claude child exists. Only then may it write
`{"type":"ready"}` to descriptor 5. The signal handlers keep the monitor
alive when the complete group receives SIGINT or SIGTERM. Claude still
receives those group signals. The monitor exits only through the final group
SIGKILL. If it dies earlier, the connector treats that death as a fault and
seals the already known group itself.

The connector sends no start command until it receives the complete ready
record. If the connector dies before readiness, descriptor 3 reaches EOF.
Once the monitor arms the handler, including when EOF was already pending, it
seals its known group without accepting a start command. CL02 and CL03 must
prove connector death during native Node startup and before this first
application action. CL04 may kill the packed connector only at an externally
observable startup point and must prove that every process group visible at
that point disappears; it makes no claim about the private readiness barrier.

Monitor readiness has a five-second monotonic subdeadline capped by the
invocation's absolute deadline. After the start record, the matching
`child_started` record has another five-second monotonic subdeadline capped by
the same absolute deadline. Neither subdeadline resets the 15-minute turn
limit.
On either expiry, the connector seals the already known monitor group and
proves it empty inside the common three-second cleanup budget. It does not
depend on a monitor lifecycle record to find the group.

The connector next sends exactly one start record on descriptor 4:

```json
{"type":"start","executable":"<canonical-claude-path>","arguments":["<fixed>","<claude>","<arguments>"]}
```

The executable must equal the factory's pinned canonical path. The argument
array must equal either the selected version probe vector or one of the exact
turn vectors below. The monitor accepts no cwd, environment, shell, stdio,
signal, timeout, or arbitrary spawn option in the command. Only after it has
validated the complete record may it call `spawn` once with `shell: false`,
`detached: false`, its inherited cwd and environment, and three owned pipes.
Claude inherits the monitor's already recorded process group. It never leads
a second group. Claude receives only its three provider-data pipes. It does
not inherit the monitor's owner or control descriptors. For the exact
`--version` vector, the monitor closes Claude stdin immediately after spawn.
For a turn vector, it resumes monitor stdin only after all three pass-through
pipes and child lifecycle handlers are attached.

The monitor installs child exit and pipe handlers before it reports
`{"type":"child_started"}`. That record carries no PID because the connector
already knows the only accepted group ID. If descriptor 3 has ended at any
point, the monitor does not report child startup or continue work. It starts
the group-sealing sequence. This rule covers connector death before monitor
readiness, after readiness, while the start record is parsed, before the
Claude spawn call, after the call, and before `child_started` publication.
There is no point at which a started Claude process belongs to an unknown
group.

After start, the only descriptor-4 commands are `{"type":"interrupt"}` once
and `{"type":"contain"}` once in their permitted states. `contain` is the
fixed request to seal the group. On descriptor 5, the monitor reports only
`child_started`, one exact `child_exited` record, or a fixed content-free
`fault` code. Unknown, duplicate, out-of-order, malformed, or excess control
fails closed and starts sealing. There is no `release`, `released`,
`group_empty`, or `no_child` record. A process-group leader cannot prove its
own group empty while it remains alive, so the connector never accepts such a
claim from the monitor.

After `ready`, the complete monitor-to-connector record set is:

```json
{"type":"child_started"}
{"type":"child_exited","code":0,"signal":null}
{"type":"fault","code":"invalid_control"}
```

In `child_exited`, exactly one of `code` or `signal` is non-null. `code` is a
nonnegative safe integer. `signal` is the positive integer value from the
current approved Node runtime's
`os.constants.signals` table, not provider text. The fixed fault-code set is
`invalid_control`, `spawn_failed`, `stream_failed`, `containment_failed`, and
`internal_failure`. A fault is never process-cleanup evidence. The connector
reflects none of these internal values outside its existing fixed content-free
errors. Every fault, including a spawn failure before Claude exists, starts
monitor-side group sealing. A living connector also seals the known group when
it receives a fault or loses either control pipe.

For a new session, use this exact argument vector after the canonical
executable path:

```text
-p
--input-format
stream-json
--output-format
stream-json
--verbose
--replay-user-messages
--safe-mode
--restricted
--permission-mode
dontAsk
--no-chrome
--disable-slash-commands
--tools
<policy-tools>
--disallowedTools
mcp__*
--session-id
<caller-generated-session-uuid>
```

For resume, replace the last two arguments with:

```text
--resume
<stored-session-id>
```

The adapter does not use `--continue`, `--fork-session`, `--bg`, `--cloud`,
`--bare`, `--allowedTools`, `--permission-prompt-tool`, `--mcp-config`,
`--plugin-dir`, `--include-partial-messages`, `--debug`, or
`--no-session-persistence`. It does not supply a prompt, model, system prompt,
settings path, settings JSON, agent, skill, output schema, additional
directory, or provider credential through argv.

The start record is the only place these Claude arguments appear before the
provider spawn. It contains opaque session metadata but no A2A input. The
monitor inherits the canonical working directory and provider-child
environment allowlist from its own sealed launch and passes them unchanged to
Claude. It adds no environment name. The connector never accepts a provider
group ID from control data. Its own positive detached-monitor PID is the one
exact group ID for the invocation.

### Sandbox, tools, and approvals

The local connector policy is a maximum. Map it only to built-in tool
availability:

| Connector policy | Exact `--tools` value |
| --- | --- |
| `read-only` | `Read,Glob,Grep` |
| `workspace-write` | `Read,Glob,Grep,Edit,Write` |

`--restricted` confines built-in file tools to the working directories. The
adapter supplies only one working directory and no `--add-dir`. Excluding
`Bash`, `WebFetch`, `WebSearch`, `Agent`, workflows, notebooks, browser tools,
and every MCP tool prevents those paths from entering the provider request.
The connector does not depend on Claude's command sandbox to contain a tool it
has removed.

The adapter always selects `dontAsk`. It never sends `--allowedTools`,
`acceptEdits`, `auto`, `bypassPermissions`, or a permission-prompt tool. It
never answers a permission request or interprets A2A text as an approval.
Anything not already permitted by Claude's trusted policy is denied.

This means `workspace-write` can narrow to read-only when no trusted managed
policy permits `Edit` or `Write`. The connector must not turn that ceiling
into an automatic grant. A provider denial is ordinary provider execution
detail. It does not become `approval_required`, and its text is discarded.

`--safe-mode` disables ordinary hooks, skills, plugins, MCP servers, custom
commands, subagents, workflows, project instructions, and auto memory while
normal authentication remains available. Anthropic documents one important
exception: administrator-managed hooks, status-line commands, and
file-suggestion commands may still run. The connector cannot override managed
policy. A supported installation must have no administrator-managed executable
hook or command that receives session or prompt data. CL04 must use such an
environment. The adapter rejects any observed pre-init hook event, but it
cannot detect a silent managed prompt hook before sending content. Until a
future Claude interface removes that ambiguity, installations with those
managed commands are outside the qualified contract.

### Stream transport and input

Stdin and stdout use UTF-8 JSON Lines. The adapter writes one compact JSON
object followed by one LF. It accepts one JSON object per LF-terminated stdout
record. Empty records, an unterminated final record, invalid UTF-8, duplicate
keys, arrays, batches, non-objects, invalid envelopes, or trailing bytes fail
the protocol.

One record is limited to 1,048,576 bytes excluding LF. JSON nesting is limited
to 100 container levels. The common 8 MiB stdout, 8 MiB stderr, 10,000-event,
1,024-byte ID, 262,144-byte final reply, and 15-minute absolute turn limits
from ADR 0030 also apply. Stderr is drained, bounded, discarded, and never
parsed or reflected.

After the durable session barrier, the adapter writes exactly one record:

```json
{"type":"user","uuid":"<invocation-uuid>","session_id":"<session-id>","message":{"role":"user","content":[{"type":"text","text":"<A2A input>"}]},"parent_tool_use_id":null}
```

The `uuid` is a fresh canonical UUIDv4 for this invocation. It is not a
recoverable provider turn ID and is not persisted. The adapter writes the A2A
input bytes only as the text block value. It then closes stdin. It never
writes input to argv, an environment variable, settings, a temporary file,
connector state, logs, diagnostics, crash output, or a support bundle.

`--replay-user-messages` asks Claude to echo accepted stdin messages on
stdout. The adapter requires one matching replay acknowledgment and retains
neither its content nor UUID after the invocation. The acknowledgment proves
only that this child accepted the input. It does not provide an exact-result
recovery operation.

Anthropic publishes the `SDKUserMessage` type used here, but it does not
publish a separately versioned CLI input schema. CL04 must prove that release
`2.1.251` accepts this exact record without rewriting its session ID or input.
Failure blocks CL03 qualification and requires a reviewed contract amendment.

### Session binding and resume

For `start`, the adapter generates one canonical UUIDv4 before launch and
passes it as `--session-id`. It holds stdin open and empty until it receives a
valid `system/init` record. That record must match the generated session ID,
version `2.1.251`, canonical working directory, `dontAsk` mode, exact tool
list, empty MCP server list, and empty plugin list. Any startup event before
init, including a hook or plugin-install event, fails before provider input.

After validation, the adapter emits exactly one `session_bound` event with the
session ID and yields control. The connector foundation durably stores the
encrypted session ID before it requests the next provider event. Only that
next pull permits the adapter to write stdin.

For `resume`, the adapter passes only the stored session ID through
`--resume`. It never searches by name, chooses the most recent session, forks,
or creates a replacement. It holds stdin until a matching init record passes
the same checks, then emits the matching `session_bound` event before writing
input. A missing or mismatched session before input is
`failed/provider_start_failed`. Once input may have reached Claude, absence or
mismatch is uncertain.

Anthropic documents `system/init` as the first normal stream record, with
startup hook and plugin events as possible predecessors. It does not document
that init arrives while stream-JSON stdin is open but contains no user
message. CL04 must prove that timing. If Claude waits for input before init,
the selected interface cannot satisfy the durable session-before-prompt rule
and must not be qualified.

### Accepted output subset

Production uses closed Zod schemas copied from the official message reference
for release `2.1.251`; it does not depend on the Agent SDK at runtime. Every
accepted record must contain the exact current session ID. A present UUID must
be a bounded canonical UUID. A record tied to a subagent is rejected because
the `Agent` tool is unavailable.

The adapter accepts only these record classes:

- one `system/init` record during the session barrier;
- the exact replayed initial `user` message;
- bounded main-session `assistant` and provider-generated `user` tool-result
  messages, whose content remains transient and is discarded;
- bounded API-retry, rate-limit, status, compact-boundary, tool-progress, and
  tool-summary records, which may produce only content-free progress;
- one terminal `result` record.

Partial-message, prompt-suggestion, subagent, task, workflow, file-persistence,
hook, plugin-install, cloud, remote-control, channel, browser, MCP, approval,
authentication-control, mirror-error, configuration, unknown, or malformed
records fail closed. A control failure before input is a definite start
failure. After input, it is uncertain unless one exact terminal provider
result already proves the outcome.

A matching terminal `result` with subtype `success` must contain one nonempty
string `result` within the final reply bound. It maps to one `reply` event.
The adapter does not construct a reply from assistant deltas or tool results.
An exact documented terminal error maps to
`failed/provider_execution_failed`. A matching terminal success with a
missing, empty, malformed, or oversized final string maps to
`failed/provider_result_invalid`.

EOF, process exit, timeout, signal, cancellation, stdout or stderr overflow,
parser failure, conflicting records, or missing terminal result after input
maps to `uncertain/provider_outcome_unknown`. The adapter never emits
`completed_without_reply`, `approval_required`, `approval_resolved`, or a safe
`cancelled` result for this provider.

### No exact-turn recovery

Claude Code `2.1.251` does not expose a non-creating exact-turn result lookup
through the selected CLI. `--resume` continues a session and may continue an
unfinished turn. It is not recovery evidence. The connector must not inspect
Claude's transcript files to manufacture such evidence.

The adapter therefore never emits `turn_bound`; durable `provider_turn_id`
remains null. `recover` with a null or unexpected non-null turn ID starts no
process, opens no provider file, sends no input, and immediately emits
`uncertain/provider_outcome_unknown`. A crash after the durable dispatch
decision can close the A2A conversation as uncertain, but it can never start a
replacement Claude turn.

Only a session whose previous A2A turn ended with an exact reply may be used
for a later `resume`. A session attached to an uncertain turn remains unusable
for new work under ADR 0030.

### Cancellation and terminal teardown

For a live Claude group, `cancel` sends the monitor one fixed `interrupt`
command. The monitor sends SIGINT once to the negative monitor PID, which is
the exact known group ID. Claude receives the signal. The monitor's installed
SIGINT handler keeps the group leader alive to supervise later teardown.
Anthropic documents SIGINT as the way to end a headless turn. SIGTERM is not a
safe cancellation result because Claude records the turn as unfinished and a
later resume continues it. The adapter makes no safe cancellation claim from
the signal alone.

The common ten-second cancellation grace uses the original absolute provider
deadline and never resets it. If one valid terminal result arrives during the
grace, normal result validation still applies. Otherwise the provider outcome
is uncertain. After the grace, the connector sends one fixed `contain`
command and starts the fixed group-sealing sequence. It sends SIGTERM once to
the exact negative monitor PID, waits no more than one second, then sends
SIGKILL once to the same group. The monitor catches the group SIGTERM so its
cleanup logic does not stop early. The final SIGKILL
intentionally terminates the monitor as well as Claude and any descendant
still in the group. The connector reaps its direct monitor child and proves
the exact group empty within one absolute three-second budget. It never
searches by name, command line, directory, or a guessed PID.

On normal completion, the adapter closes monitor stdin after the one prompt,
drains bounded provider output, and holds any terminal candidate. Prompt EOF
is not an owner-death signal. Descriptor 3 stays open. The monitor may report
its direct Claude child's exact exit code or signal, but that record is not
group-emptiness evidence. After bounded output drain and result validation,
the connector always sends `contain` and runs the same TERM-then-KILL sequence,
even when Claude already exited. There is no normal release path. Killing the
monitor-led group is the only terminal transition.

The connector keeps descriptor 3 open through sealing. After the final group
signal closes the data and control streams, it completes the bounded drain,
reaps the direct monitor, and probes the exact negative group ID until the OS
reports `ESRCH` from a signal-0 check. Any other result remains nonempty or
unproven. Only then does it close its owner-pipe write end and emit a terminal
provider event. A late conflicting provider record, monitor status, or control
fault invalidates the held candidate and becomes uncertain after successful
cleanup. Unproven group cleanup emits no terminal provider event and follows
the foundation's content-free `connector_provider_cleanup_incomplete` path.

Descriptor 3 is the hard-crash ownership mechanism. EOF, close, or error on
that pipe at any startup or execution state starts monitor-owned containment
without waiting for another connector command. The monitor sends SIGTERM to
its own exact group, catches that signal, waits no more than one second, then
sends the final SIGKILL to its group. This applies before readiness, before or
after the start command, before or after Claude spawn, after prompt EOF,
during output drain, and after terminal output. No separate Claude group or
group-ID publication exists.

Any internal monitor control or lifecycle fault enters the same containment
path. If the monitor dies unexpectedly while the connector lives, the
connector already knows the exact group and runs the fixed TERM-then-KILL
sequence before it considers any result. If the connector dies, the monitor
cannot be reaped by that connector. CL04 must externally prove that the group
disappears and the OS reaps the orphaned process unit. CL02 must make the
production monitor enter sealing for every injected internal fault. CL02 and
CL03 must prove owner-pipe behavior at every private startup and execution
barrier. CL04 proves the same packed monitor contains real processes after
connector death at externally observable startup and active-execution points.

### History, retention, and retirement

Claude Code owns content-bearing transcripts under the user's normal account
home. Anthropic documents that session history includes prompts, tool calls,
tool results, and responses, and that the default cleanup period is 30 days.
Those files and any account-managed retention policy are outside connector
custody.

The connector uses `--session-id` and `--resume` but never enumerates, opens,
parses, copies, hashes, logs, diagnoses, deletes, or modifies Claude history.
It also never calls Agent SDK session-list or message-reading functions.
Missing or changed provider history fails closed through the selected CLI.

`a2a-claude-connector retire-state` removes only the connector's encrypted
opaque correlation state under ADRs 0028 and 0029. It does not log Claude out,
run a Claude purge command, change Claude retention, or delete provider
history. User documentation may point to Claude's own history controls, but
the connector never invokes them.

### Authentication, license, packaging, and updates

Claude Code owns its existing authentication. The child may use only the
authentication that the official CLI resolves under the account home passed
by ADR 0028. The connector does not copy a token, API key, credential file,
keychain entry, provider history, or authentication status into its process,
state, fixtures, CI, diagnostics, or package.

The official CLI's use is governed by Anthropic's applicable Consumer or
Commercial Terms. The npm metadata uses a terms reference rather than an
open-source redistribution license. The MIT connector remains separate. It
does not bundle, link, copy, modify, or redistribute the CLI or Agent SDK.

Users install, authenticate, update, and remove Claude Code themselves. The
connector performs no download, installation, login, token setup, package
manager operation, update, or version selection. An automatic provider update
makes preflight fail closed.

Updating the accepted version requires a new ADR amendment. The amendment
must inspect official release and license changes, review every selected input
and output shape, advance the fake red specification first, repeat the full
artifact and containment matrix, and repeat CL04 on every claimed platform.

This decision does not approve public connector publishing, stable support,
real-provider CI, Windows support, or a real-provider qualification claim.

## CL02 red specification plan

CL02 adds a full-process fake Claude CLI and a classified expected-red
inventory before production adapter code. The fake executable is available
only through a private test seam. No public CLI, environment option, provider
selector, dependency, executable, credential, or staged control is added.

| ID | Red case | Required observation |
| --- | --- | --- |
| L01 | Resolve no executable; hang, overflow, signal, or fail the monitored version probe; report a wrong, prerelease, later, or alternate-form version; change the canonical target or identity | Bind only after the connector seals the known monitor group, reaps its monitor child, and proves the exact group empty; submit no provider input, install nothing, and expose only the fixed safe failure |
| L02 | Inspect every monitor launch and its version, new-session, and resume start record under both policies | Exact `process.execPath`, packaged monitor, `shell:false`, `detached:true`, canonical cwd, scrubbed environment, connector-recorded monitor PGID before start, Claude `detached:false`, exact Claude executable and arguments only on bounded control, and no prompt or reply outside provider stdin |
| L03 | Start with init-before-input, input-before-init, missing init, startup hook or plugin records, duplicate init, wrong session, wrong cwd, wrong version, wrong tools, wrong permission mode, or nonempty MCP or plugin state | Publish only one fully validated session; write no input before its durable barrier |
| L04 | Hold the fake after `session_bound` | Observe no stdin message until the connector requests the next provider event after durable encrypted state publication |
| L05 | Resume an exact, missing, malformed, or mismatched stored session | Pass only the exact stored ID; never continue, search, fork, or create a replacement |
| L06 | Inspect the stdin record with commands, flags, paths, newlines, JSON, settings, skill syntax, and environment assignments in A2A text | Preserve every input byte only in the one text block; use one LF record and close stdin |
| L07 | Replay the exact input, omit it, duplicate it, change its UUID, session, role, parent, or text, or replay it after a conflicting record | Accept one exact acknowledgment only; persist none of it and derive no recovery claim |
| L08 | Exercise read-only and workspace-write launch mappings | Expose only the exact fixed tool lists, `dontAsk`, safe mode, restricted mode, no approval or broader-authority flag |
| L09 | Return permission denial and every approval, interactive, authentication, config, MCP, browser, channel, cloud, remote, agent, task, workflow, hook, and plugin control record | Grant and answer nothing; discard detail; reject the unsupported protocol |
| L10 | Emit valid assistant text, tool calls, tool results, thinking, retry, rate, status, compaction, tool progress, and tool summaries | Keep all content transient, emit at most content-free progress, and use none as the final reply |
| L11 | Emit exact success, exact provider error, empty result, malformed result, multiple result, mismatched session, conflicting result, and oversized result | Normalize only one exact valid terminal reply; classify authoritative invalidity without replay |
| L12 | End through EOF, exit, timeout, signal, missing result, parser failure, stdout overflow, stderr overflow, or event overflow before and after input | Distinguish definite pre-input start failure from post-input uncertainty |
| L13 | Send invalid UTF-8, duplicate keys, arrays, batches, non-objects, unknown fields or record types, unterminated records, depth 100 and 101, and 1 MiB and one-over records | Accept exact raw boundaries and fail closed on every excess |
| L14 | Reach the common session-ID, event, progress, reply, stdout, stderr, count, and absolute deadline limits | Preserve every ADR 0030 boundary without extending a deadline |
| L15 | Crash the connector before monitor readiness, before start, during the start record, before and after Claude spawn, before and after `child_started`, before init, after session publication, during stdin write, after replay, during tools, and after terminal output | Let owner-pipe EOF seal the already known monitor-led group; externally prove the group disappears and the OS reaps the orphaned process unit; never start a replacement session or turn, and keep post-dispatch outcomes uncertain |
| L16 | Call `recover` with null and non-null turn IDs | Start no process, inspect no provider history, submit no input, and return uncertainty first |
| L17 | Cancel before init, after session binding, during stdin, during execution, after result, and after exit | Send at most one fixed monitor interrupt, signal only the known monitor-led group, keep the monitor alive through SIGINT, grant nothing, extend no grace, and make no safe cancellation claim from SIGINT |
| L18 | Hold the Claude root and descendants through normal exit, cancellation, prompt EOF, SIGINT, SIGTERM, and SIGKILL | Keep the owner pipe open after prompt EOF; always seal with bounded TERM then KILL; emit no terminal event until the connector reaps the monitor and proves the exact group empty |
| L19 | Send a terminal candidate followed by a late provider conflict, lifecycle conflict, monitor fault, or descendant output | Invalidate the candidate when required, complete containment, and keep provider and monitor detail out of errors and diagnostics |
| L20 | Scan connector state, SQLite, argv, environment, settings, logs, diagnostics, temp paths, crash artifacts, stage, pack, and installed files | Find no A2A input, reply, tool data, approval detail, Claude credential, provider history, or fake control |
| L21 | Place content-bearing Claude-like history beside the fake and mutate or remove it between turns | Never open, copy, hash, inspect, delete, or repair it; use only the CLI resume result |
| L22 | Run two turns in one fake session and two concurrent conversations through the K04 chain | Preserve exact session resume, global concurrency, reply-before-ack, and one terminal provider result per turn |
| L23 | Load an absent, partial, malformed, or test-seamed production adapter or lifetime-monitor module | Permit only the reviewed missing-adapter red marker; fail every partial, missing-monitor, extra-process, or leaked-seam shape |
| L24 | Send missing, duplicate, malformed, oversized, over-depth, excess, unknown, or out-of-order monitor commands and lifecycle records; mismatch the executable, arguments, child exit pair, or fault code; forge a PGID, release, released, no-child, or group-empty record | Start Claude only after one valid ready and start exchange; automatically seal on every protocol fault; reject every group claim because the connector's monitor PID is authoritative; never treat fault or lifecycle data as cleanup or terminal evidence |
| L25 | Kill the connector after the prompt bytes and EOF have reached Claude but before any provider output | Detect descriptor-3 EOF independently of prompt stdin, send bounded TERM then KILL to the known monitor-led group, and externally prove that the group disappears and the OS reaps it |
| L26 | Kill the connector after a terminal provider result while Claude or one descendant still lives | Discard the uncommitted terminal candidate, let the monitor seal the complete group, and externally prove that no monitor or provider process remains |
| L27 | Exercise connector PGID capture, ready, start, `child_started`, `child_exited`, contain, TERM, KILL, monitor-reap, and connector group-proof ordering; inject monitor death and internal faults at every barrier | Never release the monitor; keep the content-free owner pipe open through output drain; use the already known group after unexpected monitor death; emit a terminal provider event only after the connector proves the process unit gone |

CL02 keeps normal repository tests green and adds its exact inventory to the
reviewed red-inventory runner on Linux and macOS. It invokes no real Claude
binary and reads no user Claude home. The team must review every expected
failure before CL03 implements the production adapter.

## CL04 manual qualification gates

CL04 runs only when the user explicitly provides a suitable authenticated,
disposable environment. CI never downloads Claude Code, signs in, reads real
history, or uses provider credentials.

CL02 and CL03 own every assertion that requires visibility into the private
monitor protocol or injection at an internal protocol barrier. Their fake
full-process suite must prove the byte-exact `ready`, `start`,
`child_started`, `child_exited`, contain, TERM, KILL, monitor-reap, and
connector group-proof ordering; every malformed or out-of-order control
record; every injected monitor, spawn, and control-channel fault; and
connector death at each internal barrier. Those assertions run against the
same production adapter and packaged monitor used by CL04.

The packed production artifact exposes no monitor observation, barrier, or
fault-injection channel. CL04 must not add one, change the public CLI, or pass
test controls through provider argv, environment, stdin, configuration, or
files. CL04 therefore qualifies externally observable real-runtime behavior.
It complements the internal fake proofs instead of duplicating private
protocol instrumentation in a real provider account.

Each claimed provider and platform pair must pass all of these gates through
the packed connector and full local gateway chain:

1. official executable identity and exact version stdout;
2. complete real start and resume through the adapter's enforced
   session-before-input state machine; CL02 and CL03 prove its internal
   init-before-input ordering while stdin remains open and empty;
3. send adversarial input only through the selected structured provider
   interface and find no argv, environment, artifact, or diagnostic
   reflection; CL02 and CL03 prove byte-exact `SDKUserMessage` acceptance and
   replay;
4. two turns in one caller-generated and exactly resumed session;
5. safe and restricted startup with no user or project customizations and no
   administrator-managed executable hook or command;
6. harmless in-root read, denied out-of-root read, policy-dependent in-root
   write, denied out-of-root write, and no tool-mediated network access;
7. denied permission and unsupported-control behavior without a connector
   grant;
8. externally observe one monitor-led process group containing the expected
   Claude root and descendants, retain its identity only in memory, and prove
   the exact group and tracked processes gone before accepting a terminal;
9. SIGINT cancellation with the monitor kept alive, provider timeout, normal
   exit, and mandatory held-group sealing;
10. connector hard death during externally observable startup, proving every
    observed process disappears; CL02 and CL03 prove the internal pre-ready,
    start, spawn, and `child_started` barriers;
11. connector hard death while a real Claude turn is externally observed as
    active, proving the monitor, Claude root, and descendants gone and the
    orphaned unit OS-reaped; CL02 and CL03 prove the exact prompt-EOF and
    post-terminal barriers;
12. externally induced monitor hard death with the known group contained and
    no orphan, content reflection, or accepted terminal result; injected
    internal and control-channel failures remain mandatory CL02 and CL03
    proofs;
13. restart after every durable barrier with no blind turn replay;
14. provider-owned history usable for resume but never opened by the connector;
15. complete artifact, state, process-argument, environment, output, temporary
    path, and disposable-account scans.

Failure of either protocol timing gate, sandbox containment, or hard-crash
containment leaves that provider and platform pair unsupported. Fake success
does not substitute for externally observable real-runtime evidence, and a
real run does not substitute for the internal fake fault matrix. If no
suitable authenticated environment is available, CL04 remains pending and
the project makes no real Claude qualification claim.

## Alternatives

- **Claude Agent SDK 0.3.251.** It adds a production package and bundled native
  binary, expects a different third-party authentication model, exposes
  content-bearing history APIs the connector cannot use, and still lacks a
  documented session-before-input or non-creating exact-result lookup.
- **Bare mode.** It disables more customizations, but Anthropic documents that
  it does not read subscription OAuth credentials or the system keychain. It
  would require an API key or credential helper outside the accepted child
  environment.
- **Prompt text in argv.** This is simpler but exposes sender content in the
  process list and violates the connector data boundary.
- **Automatic approvals.** `--allowedTools`, `acceptEdits`, `auto`, and
  `bypassPermissions` would grant authority without a provider-owned user
  decision available through this connector.
- **Transcript-based recovery.** Reading Claude JSONL history would copy and
  inspect provider-owned prompt, reply, tool, and permission content. The
  selected CLI also does not promise that internal transcript format as a
  stable exact-result API.
- **A compatible version range.** Claude's CLI protocol and security behavior
  change between releases. A range would make an update an unreviewed policy
  and parser change.

## Costs and risks

Exact pinning is strict. A normal Claude update disables the adapter until the
new release is reviewed. The selected CLI offers no exact-turn recovery, so a
connector or provider crash after input closes that A2A conversation as
uncertain even when Claude later completed the work.

`dontAsk` can make workspace-write act as read-only. That is the intended
result when no trusted provider policy grants edits. Claude's own history
contains conversation content and outlives connector retirement. The
connector discloses that behavior but never enters provider history custody.

The public documentation does not settle init-before-input timing or the exact
CLI input record. Safe mode also preserves administrator-managed executable
hooks. CL04 must close the first two gaps and exclude the third condition for
each supported environment. Until then, this ADR authorizes contract-first
fake tests and implementation, not a real-provider support claim.

The lifetime monitor adds one packaged Node process and one small private
protocol to every probe and turn. That extra process is the cost of keeping an
owner-death signal after prompt EOF. A monitor fault is never accepted as
provider completion or cleanup evidence, and the real monitor topology still
needs CL04 on every claimed platform.

## Approval

Accepted on 2026-08-31. The user approved the separately installed official
Claude Code headless CLI at exactly `2.1.251`, caller-generated session IDs,
structured stream-JSON stdin and stdout, no per-turn recovery, no new
dependency, and the qualification gates in this record.

The independent CL01 review amended that approval before CL02 to require the
packaged Node lifetime monitor, zero-byte owner pipe, and bounded command and
status pipes. The connector starts the monitor detached and records its PID as
the exact process-group ID before start. Claude joins that group without
detaching. Every terminal path seals the group with TERM then KILL, and only
the connector may prove it empty. The amendment adds no dependency or provider
executable.

This acceptance authorizes CL02 and, after review of its exact red failure
inventory, CL03. It does not authorize provider installation, authentication,
an SDK, a dependency or lockfile change, a public CLI change, real-provider CI,
publishing, stable support, Windows support, or a real qualification claim.
