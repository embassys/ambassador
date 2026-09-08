# 0070 Bind native observers to the configured local instance

Status: accepted under the approved instance-isolation work in ADR 0064

Date: 2026-09-08

The user requested completion of remaining work, excluding platform testing.
Review found that OpenClaw's return extension still always observed port 8787.
An OpenClaw profile connected to another desktop instance therefore observed
the wrong gateway. Its route journal also had no endpoint scope.

Resolve the `ambassador` entry from OpenClaw's trusted plugin configuration.
Accept only an enabled Streamable HTTP connection at a literal
`http://127.0.0.1:<port>/mcp` URL. Reject missing, disabled, authenticated, remote,
or conflicting executable configurations. Never fall back to the default port.
Tool arguments cannot choose this endpoint or the conversation destination.

Keep the single provider-owned observer lock. Store each endpoint's ID-only
routes beneath a SHA-256 namespace within the existing private bridge directory.
Changing configuration requires a provider restart and cannot bind new tool
events to the previous observer. Restarting with the original endpoint resumes
its saved routes. The older unscoped journal is left untouched; there is no
migration or replay of its routes. Saved results remain available through MCP.

Endpoint separation does not identify an enrollment after a port is reused.
Operation UUID correlation and the gateway's enrollment-bound stores continue
to apply. No cross-instance search or copying of requests is allowed.

The native retest also reproduced website discovery and an unnecessary detached
wait task. The optional `before_prompt_build` hook contributes short, compiled
Embassys registration and continuation guidance. It does not read or persist
the prompt or history, change tools, or interpolate configuration or peer data.
It contributes nothing without a valid local Ambassador connection. OpenClaw's
conversation-hook permission and prompt-injection policy remain authoritative;
normal configuration never grants these options automatically. This is a
provider extension refinement, not a change to the user's prompt or permissions.
When a host refuses verification codes in chat, the guidance sends the owner to
Registration in the Embassys app for the same installation. Host credential
policy remains authoritative; do not bypass it to complete a qualification run.
The hook and its gates are documented in the reviewed
[OpenClaw plugin API](https://docs.openclaw.ai/plugins/hooks#prompt-and-model-hooks).

Keep foreground waits, idle checks and explicit result receipts. This change
does not fix or qualify the provider's duplicate display badge. No new API,
dependency, CLI flag, provider credential handling or release is involved.

Tests cover two live local MCP servers, identical request IDs in separate route
stores, disabled/malformed configuration, endpoint changes across registrations,
restart, argument spoofing and rejection before network access. Native evidence
must distinguish gateway history from actual desktop rendering.
