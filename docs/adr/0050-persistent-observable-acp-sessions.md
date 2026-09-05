# 0050 Persistent and observable ACP sessions

Status: accepted; verbose logging amended by ADR 0051, running inspection
amended by ADR 0053, automatic ACP approval superseded by ADR 0055, and
peer reuse, history bounds, and retention amended by ADR 0056

Date: 2026-09-04

## Problem

Direct delivery currently treats each ACP turn as disposable. Ambassador
creates a new session, denies every ACP tool permission request, discards the
session identifier, and terminates the agent. The Claude bridge also disables
session persistence and built-in tools while bypassing provider permissions.
Hermes and Codex receive a second Ambassador MCP definition through ACP even
though setup already requires users to configure Ambassador in the provider.

This prevents useful continuity and makes delivery hard to inspect. It also
creates four different execution policies for what should be one direct-mode
contract.

## Decision

### One direct-delivery policy

Apply the same ACP v1 policy to OpenClaw, Hermes, Codex, and Claude Code:

- use the provider's normal configuration for Ambassador MCP and every other
  provider tool;
- send an empty `mcpServers` array in ACP session lifecycle requests;
- keep provider built-in tools enabled;
- do not request a provider bypass, safe mode, restricted mode, or disabled
  tool set;
- when the agent asks the ACP client to approve a tool, select an
  `allow_once` option when present, otherwise select the first positive option
  advertised by the agent;
- if the agent offers no positive option, cancel the request because ACP gives
  the client no approval it can select; and
- retain the provider's normal authentication and billing behavior. Native
  subscription login works without an API key, while an API key deliberately
  configured in the provider environment remains supported.

The automatic tool approval below was a temporary development policy and is
superseded by ADR 0055. It gave a
background direct-delivery turn access to the tools available in the user's
provider configuration. A fixed Embassys prompt marks remote fields as data,
but it is not a hard prompt-injection boundary. The user accepted this risk to
unblock unattended development flows. A later approval service may replace
automatic approval without changing the central permission protocol.

### Adapter distribution

Use the reviewed public ACP adapters for Codex and Claude Code. Their
production dependency declarations use unpinned npm wildcards, so a fresh or
updated Ambassador installation resolves the current adapter release. Running
`ambassador start` never downloads packages or changes an existing
installation. OpenClaw and Hermes continue to provide their own ACP commands.
All agent versions remain diagnostic metadata rather than compatibility gates.

Remove Ambassador's built-in Claude bridge. The Claude ACP adapter launches
the official Claude runtime and owns its provider integration. Ambassador does
not add authentication flags, inspect provider credentials, or promise a
specific provider billing method.

### Session ownership and lifecycle

Reuse one provider session per central-issued remote agent identity, scoped to
local enrollment, fixed provider, and canonical working directory. Never use a
payload identity. Keep bounded provider IDs, peer bindings, per-message dispatch
states, independent action correlations, and lifecycle timestamps in SQLite.
No message body, prompt, tool data, provider history, or credential belongs there.

Require `session/resume` or `session/load`; prefer resume without replay except
for OpenClaw's fixed load path in ADR 0056. A prepared message may retry before
dispatch. Dispatched, completed, or uncertain
messages cannot be prompted again. Other messages from the same peer reuse
context. Use the new schemas directly without migrating existing state.

Central acceptance of `submit_action_result` settles only that call, including
when a different MCP chat submits it. Pending calls and unfinished or uncertain
dispatches prevent automatic retirement. Reusable sessions become eligible for
retirement and cleanup after 30 idle days with no unfinished work.
Cleanup runs in the background at startup and daily, drains indexed bounded
batches, and releases provider control between records. Delete provider history
when ACP supports deletion; otherwise forget local metadata. Transient failures
remain for the next pass and do not starve later records. Keep at most 1,024
sessions and a 256 MiB metadata database. Prune settled correlations after 30
days; keep unresolved correlations. Closing an adapter does not delete history.

Provider-native compaction owns the model context. Ambassador streams history
replay with individual event bounds, keeps normal turn output bounded, and shows
only a labelled recent preview of large histories. Compaction never implies an
action completed or an encrypted inbox record can be removed.

### CLI and diagnostics

The public commands become:

```text
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

ADR 0053 allows `list` and `show` while the foreground process runs, with that
process retaining exclusive ACP control. `list` reads Ambassador-owned
metadata. `show` asks the configured ACP agent to load provider history and
prints user and agent messages. Its verbose form also prints bounded tool
events. `delete` and `forget` still require the foreground process to be
stopped. `delete` requires advertised ACP deletion and removes local metadata
only after provider success. `forget` removes only Ambassador's local record
and leaves provider history alone.

`start --verbose` writes bounded execution events to the console. It may show
message data, MCP arguments and results, and central response bodies, so the
startup banner warns that personally identifying data may appear. It always
redacts authorization, DPoP material, nonces, access tokens, verification
codes, private keys, cookies, and webhook secrets. Verbose output is never
persisted.

`clean` also removes the ACP session database. It does not delete provider
sessions because local reset must not start providers or make external
changes.

## Consequences

Direct agents can use their normal resource tools, and ACP permission behavior
is consistent across providers. A user can inspect retained sessions and
remove them deliberately. Provider session history may remain after local
metadata is forgotten or cleaned.

The unpinned dependency ranges make fresh installations follow adapter releases.
The lockfile still records the versions tested by this repository. An
incompatible future adapter fails through the existing bounded ACP startup
path and must be fixed in Ambassador rather than hidden behind a version gate.

## Superseded decisions

This record supersedes:

- ADR 0038's session MCP injection and denial of ACP approvals;
- ADR 0039's rule that `start` accepts no options;
- ADR 0045's exact Codex adapter dependency;
- ADR 0047's built-in Claude bridge and non-persistent sessions; and
- ADR 0049's Claude-only permission bypass and disabled built-in tools.

The fixed agent registry, no-shell launch, provider-owned authentication,
central credential custody, and encrypted pending-action inbox remain in
force.

## Approval

The user approved common provider-configured tools, the then-temporary automatic positive ACP
permission selection, persistent inspectable sessions, CLI session management,
redacted verbose output, current adapter releases, and 30-day retirement on
2026-09-04.
