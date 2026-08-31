# 0036 Gemini CLI interface evaluation

Status: accepted

Date: 2026-08-31

## Problem

ADRs 0024 and 0028 through 0031 require each connector to select one exact
provider interface before writing its fake red suite or production adapter.
The selected interface must accept provider input through an approved
structured stdin or SDK message. It must also enforce the connector's local
policy maximum, keep prompts out of process arguments, recover an exact prior
turn or report uncertainty without replay, and provide bounded child-process
containment.

GM01 evaluated the stable Gemini CLI headless interface. The review used only
Google's release, source, documentation, package metadata, and license. It did
not install, execute, authenticate, or modify Gemini CLI.

User approval on 2026-08-31 accepted this evaluation and directed the project
to preserve the existing input, policy, and containment requirements. This
record therefore rejects the evaluated interface for production use.

## Evaluated candidate

| Area | Candidate |
| --- | --- |
| Executable | Separately installed `gemini` from `@google/gemini-cli` |
| Exact version | `0.57.0` from the official [`v0.57.0` release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.57.0) |
| Output | Non-TTY `--output-format=stream-json` JSON Lines |
| New session | Connector-generated UUID passed through `--session-id=<uuid>` |
| Resume | Exact stored UUID passed through `--resume=<uuid>` |
| Input | Raw prompt bytes on stdin followed by EOF |
| Approval modes considered | `default`, `auto_edit`, and `plan`; never `yolo` |
| Sandbox considered | Gemini CLI's `--sandbox` wrapper |
| Runtime | Node.js 20 or later, owned by the external Gemini CLI installation |
| License | [Apache License 2.0](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/LICENSE) |

The version pin comes from the official release and the CLI package's
[`package.json`](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/packages/cli/package.json).
The repository's pinned
[`package.json`](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/package.json)
sets the Node.js runtime requirement.
The evaluated output types are the exact `v0.57.0`
[`StreamEvent`](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/packages/core/src/output/types.ts)
definitions, not the current documentation for another release.

### Candidate stream contract

The candidate emits one UTF-8 JSON object per LF-terminated stdout record. Its
selected event subset is:

- one initial `init` event with `timestamp`, `session_id`, and `model`;
- one `message` event with `role: "user"` that echoes the submitted prompt;
- zero or more `message` events with `role: "assistant"`, `content`, and
  `delta: true`;
- bounded `tool_use`, `tool_result`, and `error` events whose content the
  connector would validate and discard; and
- one terminal `result` event with `status: "success"` or `status: "error"`.

The `result` event contains no final reply. A candidate adapter would have to
concatenate ordered assistant deltas, hold those bytes in memory, and release
them only after an exact successful `result` and complete process cleanup. It
would apply ADR 0030's common limits plus a 1,048,576-byte raw-record limit and
a JSON nesting limit of 100. Invalid UTF-8, duplicate keys, unknown event
shapes, bad ordering, an unterminated final record, overflow, and output after
the terminal event would fail the protocol.

For a new conversation, a candidate adapter could generate a canonical UUID
and publish `session_bound` before launching Gemini with
`--session-id=<uuid>`. It could then require the first `init.session_id` to
match. Resume could use only the full stored UUID. It could never use `latest`,
a numeric session index, `--session-file`, or a replacement session after
history loss.

Gemini CLI exposes no stable per-turn identifier or exact-turn read operation
in this interface. `provider_turn_id` would remain null. Recovery after
possible dispatch would have to start no provider process, send no prompt, and
report `uncertain/provider_outcome_unknown`. Resuming the session and replaying
the prompt is forbidden.

These details describe the evaluated candidate. They do not authorize an
adapter.

## Decision

Do not select Gemini CLI `0.57.0` as the production Gemini provider interface.
Keep GM02 and GM03 blocked. A later task may proceed only after the user
approves a new stable interface that satisfies every existing boundary. The
project must add a new ADR or supersede this one before writing the fake red
suite or production adapter.

Four independent findings block this candidate.

### Input is not structured

Gemini CLI's headless mode reads the prompt as raw stdin. `stream-json` applies
only to output. It does not provide a structured request envelope on stdin.
This fails ADR 0030 and the provider security requirement that provider input
use an approved structured stdin or SDK message.

The `--prompt` flag and positional prompt syntax are not alternatives. They put
untrusted prompt text in process arguments, where process listings and crash
artifacts can expose it.

### Approval policy cannot preserve the connector maximum

No documented `0.57.0` approval mode safely maps the connector's two policies:

- `auto_edit` automatically approves file replacement and write tools. It
  silently grants authority and cannot represent `workspace-write`.
- `plan` is documented as experimental, under development, and not fully
  functional. In noninteractive execution, leaving Plan Mode can switch the
  CLI to YOLO mode automatically.
- `default` treats an interactive approval request as denial in headless mode,
  but that behavior is not a complete policy cap. User and administrator
  policies have higher priority than built-in rules and can allow tools without
  interaction. The stream does not attest the effective policy.

The exact `0.57.0` sources are the
[`configuration` reference](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/docs/reference/configuration.md),
[`policy engine` reference](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/docs/reference/policy-engine.md),
and [`Plan Mode` reference](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/docs/cli/plan-mode.md).
Disabling extensions does not disable higher-priority user or administrator
policy. The connector may narrow a requested policy, but it may not rely on
unobservable local settings that can widen it.

### Sandbox relaunch exposes the prompt in argv

Gemini CLI's `--sandbox` path reads stdin and relaunches a child with that input
as a `--prompt` argument. The behavior is visible in the pinned
[`gemini.tsx`](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/packages/cli/src/gemini.tsx)
source. Selecting this sandbox would copy the complete prompt into a process
argument, so it is forbidden.

Running without `--sandbox` does not solve the approval-policy finding and
provides no independently enforced filesystem boundary for this connector.

### Hard-death containment is unproven

A candidate adapter could own a POSIX process group for normal cancellation,
send `SIGTERM`, escalate to `SIGKILL`, drain both output streams, reap the direct
child, and withhold a terminal result until the group is empty. A process group
does not terminate automatically when the connector dies.

The candidate closes stdin after sending the raw prompt, so stdin owner death
cannot remain as a provider lifetime signal. The official interface documents
no parent-death contract or fixed descendant bound. The project therefore
cannot prove the complete child unit is gone after connector hard death on
Linux or macOS. No provider platform receives a support claim from this
evaluation.

## Other decisions

The connector will not add `@google/gemini-cli`, an SDK, or any of the CLI's
transitive packages to its manifest or lockfile. It will not bundle, download,
install, authenticate, sign out, update, or remove Gemini CLI. It will not use
ACP. ACP remains excluded by the user's project scope and was not evaluated.

Gemini-owned authentication and history remain outside the connector. The CLI
stores provider-owned session content under
`~/.gemini/tmp/<project_hash>/chats/`. The pinned
[`session management` documentation](https://github.com/google-gemini/gemini-cli/blob/v0.57.0/docs/cli/session-management.md)
says that history includes prompts, replies, tool inputs, and tool outputs. It
also says automatic cleanup is enabled by default with a 30-day maximum age. A
future connector must never inspect, copy, log, delete, or retire that history.
Missing or expired history must fail closed without starting a replacement
conversation.

The external package is Apache-2.0. This project would not redistribute it.
No license notice, runtime dependency, package artifact, installation step, or
platform claim changes as a result of this evaluation.

An automatic or manual update to any other Gemini CLI version does not make the
interface eligible. A future selection must pin an exact stable release, review
its input and output protocols, recheck policy precedence and sandbox behavior,
solve hard-death containment, write its red suite first, and complete real
qualification in a suitable disposable authenticated environment.

## Options left open

A future GM01 replacement may evaluate a stable structured CLI input protocol
or a supported SDK with explicit policy and cancellation controls. Either
choice is a new provider interface and dependency decision that needs user
approval. This record makes no SDK recommendation.
