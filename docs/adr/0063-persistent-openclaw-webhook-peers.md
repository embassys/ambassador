# 0063 Persistent OpenClaw webhook requester conversations

Status: accepted

Date: 2026-09-05

## Decision

The user requested one incoming conversation per requester and asked to finish
the remaining work before release. Apply this to OpenClaw webhook delivery as
well as direct ACP delivery. This replaces ADR 0042's isolated hook runs.

Send `sessionMode: "persistent"` with a fixed-prefix `sessionKey` derived from
the local enrollment key thumbprint, canonical receiver URL, fixed provider
agent ID and central-issued top-level sender ID. Hash the tuple with SHA-256
under `hook:ambassador:`. Never accept a session key from MCP input or message
payload fields. Missing enrollment scope or sender identity fails before dispatch.
Restarts preserve the key; different enrollments, receivers, provider agents
and requesters remain separate. Direct mode keeps its existing ACP peer binding.

The owner enables `hooks.allowRequestSessionKey` and restricts
`hooks.allowedSessionKeyPrefixes` to `hook:ambassador:`. A matching fixed default
key is required by OpenClaw configuration validation, but Ambassador always sends
its own derived key. Keep `agentId: "main"`, `deliver: false`, bearer
authentication, exact message-ID idempotency and the provider's normal content
wrapping. Do not switch to isolated mode after an error or change provider
configuration from production Ambassador code.

OpenClaw serializes calls sharing a resolved session key. HTTP admission is
still separate from action completion; owner replies use their saved call
correlation. Provider history and compaction remain provider-owned. Existing
isolated histories are not merged, and webhook sessions are not represented as
ACP sessions in Ambassador's session commands.

## Verification

Tests cover stable routing across target recreation, changed enrollment and
requester isolation, receiver and provider isolation, ignored payload routing
claims, invalid identities, exact body/authentication, and unchanged retry keys.
Real OpenClaw qualification must observe both turns in the same provider history.

Reviewed the installed OpenClaw hook normalization and persistent-session
dispatch source and the [official hook session contract](https://docs.openclaw.ai/gateway/configuration-reference#hook-session-and-agent-policy).
No central API, dependency or public CLI change is required.
