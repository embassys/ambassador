# 0049 Provider-configured tools in direct delivery

Status: accepted

Date: 2026-09-04

## Problem

The built-in Claude bridge used `--safe-mode`, `--strict-mcp-config`, and an
inline Ambassador-only MCP definition. This protected an unattended turn from
provider customizations, but it also removed the user's configured resource
tools. A granted calendar action, for example, could not query the user's
calendar and had to remain pending for a later interactive chat.

The other direct profiles do not have an equivalent Ambassador-imposed safe
mode. OpenClaw uses provider configuration. Hermes and Codex receive the
Ambassador endpoint through ACP while retaining the behavior of their own
agent runtimes.

## Decision

- Treat Ambassador's fixed delivery prompt as the trusted control envelope.
  Continue to delimit the validated central message as data within that
  envelope.
- For Claude, remove `--safe-mode`, `--strict-mcp-config`, and the inline
  `--mcp-config`. Use normal Claude provider configuration, including its
  user-, project-, and locally configured MCP servers, instructions, hooks,
  plugins, and skills.
- Change Claude's fixed MCP behavior from ACP session injection to provider
  configuration. The documented user-scope Ambassador MCP setup is required
  before direct delivery.
- Keep Claude's built-in tools disabled with `--tools ""`. Allow configured
  MCP tools without an interactive prompt with `--allowedTools "mcp__*"`,
  subject to provider and managed deny policy, and keep unattended permission
  prompts disabled. This lets a granted action use a configured calendar or
  other MCP tool and then call `submit_action_result`.
- Keep the fixed executable, non-persistent session, bounded output, deadline,
  no-shell launch, authentication ownership, and provider-output handling.
- Do not parse, copy, or persist provider MCP configuration or its credentials.
  The official agent process loads its own configuration.
- Do not add an Ambassador safe-mode flag to OpenClaw, Hermes, or Codex. Their
  fixed invocations remain unchanged.
- If a required provider tool is missing or fails, retain the action in the
  encrypted pending-action inbox for later user handling.

## Consequences

Claude can now complete resource-backed actions with its configured MCP tools.
The same provider configuration used in an ordinary Claude session also
affects the background delivery turn.

This deliberately broadens the background turn. Configured Claude MCP tools
are allowed without an interactive prompt unless provider or managed policy
denies them, and normal provider instructions, hooks, plugins, and skills can
load. A model may still be influenced by data inside a remote action even
though Ambassador wraps it in fixed instructions. The user accepted this
tradeoff in favor of automatic execution. Users should configure only tools
they are willing to make available to direct Embassys delivery.

Central permission and provider tool policy remain separate controls. Central
decides whether the caller may send an action. Provider configuration decides
which local resources the receiving agent can use to answer it.

## Approval

The user approved normal provider tools for direct delivery and removal of
Claude safe mode on 2026-09-04.
