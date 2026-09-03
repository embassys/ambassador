# 0043 Remove Gemini CLI and defer Antigravity

Status: accepted

Date: 2026-09-03

## Problem

The active delivery registry included Gemini CLI through its native ACP mode.
Gemini has been deprecated in the user's local workflow and Antigravity is the
intended successor. Antigravity does not yet have an approved, complete direct
profile for Ambassador.

A local evaluation established two useful but incomplete facts:

- Authenticated Antigravity CLI 1.1.25 connected to a temporary Ambassador MCP
  probe as exact client name `antigravity-client`, reported version `v1.0.0`,
  and made one real-model tool call.
- A separately obtained Antigravity ACP server initialized as ACP v1 with exact
  agent name `antigravity-acp` and reported version
  `agy_acp_server_20260818_01_RC01`. Its archive SHA-256 was
  `f122ca7e7030a27f9649da4cf1a7d80e12c48c5f6118ff35affc34d56cbf83dd`.
  Session creation failed in the authentication phase because that server used
  separate ACP credential state instead of the already authenticated `agy`
  state.

These observations do not establish a usable or reviewed fixed ACP launch
contract. A community adapter also exists, but it has not been approved as a
dependency, reviewed as an execution boundary, or qualified against the live
flow.

## Decision

Remove the Gemini CLI capability entry, version probe, setup guide, package
documentation, runner mode, and active qualification case. Do not replace it
with Antigravity in this change.

The active registry contains four agents:

| Agent | Direct | Webhook |
| --- | --- | --- |
| OpenClaw | yes | yes |
| Hermes | yes | yes |
| Codex | yes | no |
| Claude Code | yes | no |

The exact MCP client names previously associated with Gemini CLI and observed
for Antigravity are unsupported. They fail profile resolution before local
registration state is written or central registration is called.

Antigravity may return only through a later accepted decision that fixes its
client name, executable, arguments, ACP agent name, MCP setup, environment,
working-directory rules, and qualification plan. Ambassador must not download
an ACP server or adapter at runtime. Reported versions remain observational
under ADR 0041 once a future profile exists.

The local evaluation changed only a temporary MCP probe configuration. The
normal Antigravity configuration was restored byte-for-byte, temporary files
were removed, and no credential, prompt, message, or provider output was
retained.

## Consequences

- Current source has no Gemini CLI or Antigravity registration or delivery
  path.
- The supported local matrix has six modes across four agents.
- Historical qualification records still describe the artifacts and source
  candidates that contained the Gemini profile at that time.
- Published Ambassador 0.2.11 is unchanged by this source decision. Removing
  the profile from a published artifact requires a later Ambassador release.
- Antigravity authentication and ACP integration can be reconsidered without
  treating the partial local probes as compatibility evidence.

## Superseded clauses

This record supersedes ADR 0038's Gemini capability profile, setup, and active
qualification requirements. It also supersedes ADR 0036 as a route to an
enabled Gemini profile. ADR 0041 remains authoritative for observational
version handling among supported and future reviewed profiles.

## Approval

On 2026-09-03, after the local Antigravity evaluation, the user directed that
Ambassador remove Gemini and Antigravity support for now and return to the work
later.
