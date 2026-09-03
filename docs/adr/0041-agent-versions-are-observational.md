# 0041 Agent versions are observational

Status: accepted

Date: 2026-09-03

## Problem

ADR 0038 originally made exact MCP client and ACP agent versions part of each
compiled-in delivery profile. Ambassador 0.2.8 made the installed-command
version probe observational, but production still rejected a known client or
agent when its reported version was not listed. A newer Claude Code client, for
example, could not create a delivery profile even though Ambassador had not yet
tried its fixed direct contract.

Provider and adapter releases change independently of Ambassador. A reported
version is useful qualification evidence, but it does not reliably predict ACP
v1 compatibility. Rejecting solely on that value prevents compatible releases
from being tried and can strand registration before email verification.

## Decision

Keep the fixed capability registry and make every provider-reported version
observational:

- Match bounded MCP `clientInfo.name` exactly to one compiled-in client name.
  Require a bounded `clientInfo.version` value because it is part of MCP
  initialization metadata, but do not use it to select or reject a profile.
- For direct delivery, require ACP protocol version 1 and the exact compiled-in
  `agentInfo.name`. Ignore `agentInfo.version` for compatibility rather than
  comparing it with an allowlist. The existing bounded ACP output limit still
  applies to the initialization response as a whole.
- Keep each profile's executable, arguments, delivery modes, environment
  allowlist, MCP setup behavior, and working-directory rules fixed in source.
  Neither MCP input nor provider output may change them.
- Continue the installed-command version probe for safe diagnostics and
  qualification records. Its result never enables, disables, or skips a
  delivery case.
- Attempt the fixed ACP v1 contract. If a release is incompatible, report the
  normal bounded startup, initialization, session, prompt, or delivery failure.
  Do not fall back to another command, adapter, agent profile, or delivery mode.

This policy applies equally to OpenClaw, Hermes, Codex, Claude Code, Gemini CLI,
and future reviewed profiles. Adding a future profile still requires a fixed
known client name, fixed launch contract, tests, documentation, and
qualification.

## Security

Ignoring a version does not make `clientInfo` or `agentInfo` authenticated.
The safety boundary remains the exact known name plus the immutable local
profile. A caller can select only an already reviewed command and cannot supply
an executable, arguments, environment, adapter, working directory, or new
capability. Exact ACP protocol and agent-name checks prevent a different
process speaking an unexpected protocol from being accepted merely because it
was launched under a known command.

Qualification reports may contain the separately probed bounded version and a
safe phase classification. They must not contain provider output, prompts,
message bodies, identities, credentials, tokens, or secrets.

## Consequences

- A newer release of a known client can register and try its fixed profile
  without waiting for an Ambassador allowlist update.
- Compatibility is determined by actual ACP v1 behavior, not inferred from a
  version string.
- Qualification records remain version-specific observations, not production
  allowlists or promises that every release works.
- Unknown or decorated client and ACP agent names still fail closed.
- Ambassador 0.2.8 remains version-gated. This change requires a later release
  and does not retroactively change the published artifact.

## Superseded clauses

This record supersedes only ADR 0038's MCP `clientInfo.version` and ACP
`agentInfo.version` allowlists and its instruction to reject unlisted provider
versions. ADR 0038 remains authoritative for fixed client names, commands,
arguments, delivery modes, environment allowlists, ACP v1, and qualification.

## Approval

On 2026-09-03, the user clarified that Ambassador must not hardcode versions
for Hermes, Codex, Claude Code, or any other supported agent. Ambassador should
accept the known profile, try its fixed contract, and let an actual
incompatibility fail at runtime. The user had already approved making the
installed version probe observational; this record applies that policy to
production profile resolution and ACP initialization as intended.
