# 0077. Connect agents with a discovery skill and a live check

Status: accepted, 2026-09-09. The owner approved implementation for Codex,
Claude Code, OpenClaw and Hermes and retained the extra email verification
step required by the existing API.

Extend the existing Connect flow to install a short, versioned Embassys skill
through each provider's supported skill location. Keep the skill independent
of accounts, endpoints and secrets. Its description covers communicating with
another person's agent, with explicit exclusions for local coding subagents
and a user-selected alternative channel. Use the live MCP catalog and saved
operation IDs; never invent actions or treat a permission as transferable.

The app writes configuration and skill files itself. Preserve unrelated files,
reject links and conflicting edits, and keep ownership records before writes.
Repair reconciles interrupted writes; Disconnect removes only unchanged files
owned by this app. Existing matching owner-managed files remain unowned.

After connection and any pending executor selection, launch a fresh setup
session through the fixed ACP capability for the selected provider. Use normal
provider configuration, an empty mcpServers array and a bounded prompt. It
asks for one read-only get_my_permissions call carrying a short-lived setup
challenge. The challenge authorizes no business action and never goes to central.
Only the selected running instance can observe it. A model's written claim,
health response or saved configuration is insufficient proof of connection.

Setup uses private desktop IPC. Provider tool-permission requests during setup
go to a native owner dialog with the exact offered labels and IDs. Cancel,
shutdown and expiry close the request without approval. This local owner-started
check has no central message ID and must not fabricate one for get_human_input.
Normal incoming-action approval remains unchanged. No provider login, permission
bypass, arbitrary command or external business request is part of setup.

Show settings saved separately from connection verified. Failure leaves valid
configuration and enrollment intact, with an explicit retry or reload route.
Never register again on a retry. First-time registration and owner login retain
their separate codes under API issue 7. Credential recovery remains API issue 2.
Keep native setup platform gates and qualify fresh natural-language conversations
separately from the prompted setup check. No dependency, public CLI, central API
change or release is included.

Tests precede implementation: four-provider paths, install/reinstall/repair/
disconnect, manual edits, symlinks, interrupted writes, wrong/stale challenges,
concurrent checks, provider approval cancellation, timeout, shutdown, wrong MCP
instance, no duplicate enrollment and fresh-conversation skill discovery.
