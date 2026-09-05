# 0056 Scalable inboxes and persistent peer sessions

Status: accepted

Date: 2026-09-05

## Decision

Separate durable storage capacity, bounded delivery memory, MCP response sizes,
and provider context. Each encrypted action store has a 1 GiB live-ciphertext
quota, excluding SQLite index, free-page, and WAL overhead. Each record is
bounded to 512 KiB; the serialized MCP result is bounded to 768 KiB.
Use indexed keyset pagination and bounded decryption. Do not load a complete
store during startup or an inbox read. Keep per-record and response bounds.

`get_inbox` accepts an optional bounded `limit` and opaque `cursor`. It returns
complete items and a continuation cursor when more remain. Validate and
serialize a response before removing exactly the received results included in
that response. A failed read must not consume results. The existing uncertainty
after an MCP transport disconnect remains; reading is not proof a human saw it.

Use the new local schemas directly. Existing state and migration are outside
this change, as confirmed by the user. Reject incompatible schemas; do not add
compatibility readers or migrate credentials.

Capture eligible action calls and results when a poll returns, including polls
made during a human approval wait. Feed buffered messages to the relay in
bounded batches with consistent byte and count limits. Keep other message
bodies in bounded memory. A capacity failure retains captured work and reports
the failure; it does not pretend that central can redeliver consumed messages.

Reuse an ACP session for the same central-issued remote agent identity, local
enrollment, fixed provider, and canonical working directory. Never use a
payload-supplied identity to select a session. Turns remain serialized. Keep
message dispatch state and outstanding action correlations separately from
the provider session. An uncertain dispatched message is never replayed.
Record accepted action results even before session creation; a queued action already answered from
another MCP chat does not need another provider prompt.

Retain reusable sessions while they have outstanding work. Retire and clean
sessions after 30 idle days without unfinished work. Clean in repeated
indexed batches, yielding provider control between deletions. Maintain at most
1,024 sessions and a 256 MiB metadata database; prune settled correlations after
30 days while preserving unresolved work.
Provider compaction owns model context; Ambassador does not summarize provider
history or infer action completion from a summary. Prefer ACP resume without
history replay except for OpenClaw's reviewed profile, which requires load.
OpenClaw 2026.8.2 restores its ACP-to-gateway session mapping from its ledger
in `loadSession`; a fresh process's `resumeSession` does not restore that mapping.
Select this path through the fixed capability registry, without runtime fallback.
Bound individual replay events and retain only bounded history
for inspection. Never infer a peer binding from a message payload.

A permission grant alone is not an instruction to invent an action payload.
Allow the requester to record the exact intended action payload when requesting
permission. Encrypt that local outbound intent, correlate it with the returned
permission ID, and dispatch it at most once after the matching grant. Keep
uncertain outcomes for inspection without automatic retry. Permission-only
requests remain permission-only. The local `action_payload` field is stripped
before the unchanged central permission request. It requires an explicit target
address and no message selector. Admit one outstanding intent per target/action
pair; identical requests return status and cannot replace its payload. Expose
outbound status in paginated `get_inbox`. A later explicit permission request
can replace a denied intent. Submitted intents leave after their result is captured. A `ready` intent
can safely continue on an identical request after a crash. Uncertain external
requests retain their markers and never automatically retry. Never reconstruct
intent from provider memory.

No CLI commands, provider dependencies, production REST routes, or credential
ownership change. ADR 0055's approval-option mapping and central recovery work
remain outside this change.

## Supersedes

This amends the storage and retrieval limits in ADRs 0046, 0051, and 0052, the
per-message session lifecycle in ADR 0050, and receipt buffering in ADR 0055.
It adds only encrypted outbound action intent to the body-persistence exceptions.

## Approval

The user approved the review fixes, larger paged storage, sessions per remote
identity, separate action tracking, and the necessary ADR changes on 2026-09-05.
The user also confirmed that existing state and migration need not be supported.

## Provider context

Compaction belongs to the installed provider and its configuration. It is
separate from disk retention and does not settle tracked actions. Current
provider references describe [Codex context thresholds](https://learn.chatgpt.com/docs/config-file/config-reference),
[Claude context compaction](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up),
[Hermes context compression](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching/),
and [OpenClaw compaction](https://docs.openclaw.ai/concepts/compaction).
ACP distinguishes [resume without replay from load with history](https://agentclientprotocol.com/protocol/v1/session-setup).
Ambassador does not set provider thresholds or add its own compaction algorithm.
