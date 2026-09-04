# 0048 Claude CLI owns authentication

Status: accepted; Claude MCP isolation superseded by ADR 0049

Date: 2026-09-04

## Problem

ADR 0047 required an ordinary `claude.ai` login and removed Anthropic API-key
and token variables from the Claude child environment. That made Ambassador
choose the provider's authentication method. It also prevented the official
CLI from applying authentication configured through a Console account, an API
key, an OAuth token, a cloud provider, an Anthropic profile, workload identity,
or a Claude apps gateway.

[Anthropic documents](https://code.claude.com/docs/en/headless) `claude --print`
as its programmatic CLI and
[documents](https://code.claude.com/docs/en/cli-usage) `--mcp-config` for
supplying MCP servers to that process. Its
[legal guidance](https://code.claude.com/docs/en/legal-and-compliance) for
products running Claude Code says the binary must remain unmodified, the
product must not restrict built-in authentication methods, and each user must
authenticate and pay through their own provider relationship.
[Zed follows](https://zed.dev/docs/ai/external-agents) this ownership model for
ACP external agents: the external agent owns authentication, runtime, and
billing, while Zed may forward MCP configuration over ACP.

## Decision

- Remove the `claude auth status` preflight and the `claude.ai` method check.
- Launch only the separately installed, unmodified official `claude` command.
- For this fixed built-in Claude bridge only, inherit the complete environment
  supplied to Ambassador. This preserves the official CLI's native
  authentication precedence and organization policy. Other agent profiles keep
  their compiled allowlists.
- Do not initiate provider login. A missing, expired, or rejected credential
  fails through Claude's non-interactive invocation and Ambassador's bounded
  direct-delivery error path.
- Do not inspect, parse, persist, log, return, or copy a provider credential to
  Ambassador state. Passing the existing process environment to the official
  child is not an Ambassador credential interface.
- Keep the exact executable, arguments, ACP agent name, and working directory
  fixed. User input and central messages cannot alter them. ADR 0049 later
  changes MCP handling to normal provider configuration.

## Consequences

Users configure authentication only through the official Claude CLI and their
provider. Ambassador neither requires an API key nor promises subscription
billing. The CLI decides which configured method wins.

The Claude child receives every environment value available to the Ambassador
process. This is broader than the former allowlist, but it matches what the
same installed CLI receives when the user runs it from that shell. The bridge
still uses no shell and returns no provider output. ADR 0049 defines its
current tool surface. Environment inheritance is a fixed Claude capability,
not an agent-supplied option.

Public implementations confirm the shape is established rather than novel.
[Zed ships Claude](https://zed.dev/docs/ai/use-an-existing-subscription) as an
ACP external agent. The
[ACP registry](https://github.com/agentclientprotocol/registry/blob/main/claude-acp/agent.json)
lists a Claude adapter authored by Anthropic, Zed, and JetBrains. This evidence
does not replace the terms applying to each user or a commercial agreement
where Anthropic requires one. It also does not promise that programmatic ACP
or `claude --print` use consumes the same allowance as an interactive Claude
subscription; Anthropic controls that billing policy.

## Approval

The user approved authentication-neutral Claude delivery on 2026-09-04.
