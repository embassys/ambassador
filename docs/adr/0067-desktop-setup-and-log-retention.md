# 0067 Desktop setup helpers and diagnostic retention

Status: accepted

Date: 2026-09-07

The owner approved both decisions in ADR 0066: smol-toml 1.8.0 and yaml
2.9.0 for desktop setup, and metadata-only production diagnostics with seven-day
retention. The owner increased the proposed diagnostic allowance to 1 GiB per
app instance and requested a button to remove logs.

Keep the parsers in the desktop workspace and bundle them into the host. Codex
uses TOML and Hermes uses YAML. Add only the reviewed ambassador entry with a
660-second tool timeout. Preserve unrelated settings and comments. Refuse
conflicting entries, unsupported syntax and files changed during review. Keep
the existing ownership journal and native confirmation. Disconnect only an
unchanged entry created by this app. CLI dependencies and flags stay unchanged.

Desktop logs use at most sixteen 64 MiB files. Rotate by size and at least daily
when writing. Remove segments whose oldest record is seven days old, on opening,
writing and periodic maintenance. Expiring an entire segment can remove newer
records in that segment too. An app that is not running cannot delete files;
expiry runs when its instance next starts or its diagnostics are opened.

Development builds retain bounded, credential-redacted bodies. Production
builds retain event names, timestamps and an allowlist of operational metadata;
they exclude bodies, headers, arbitrary error text and provider output. An
explicit build setting selects the policy, recorded in the verified manifest
and passed through private worker initialization. An agent cannot change it.

Browse files in bounded pages without loading the retention allowance into
memory. Export previews have a separate 32 MiB limit; larger selections require
a narrower time range. Show that limit in the app. Keep new export files private
and require the existing native save dialog.

Clear logs is a separate, confirmed app operation. Serialize it with the active
logger, or acquire the stopped instance's lock. Validate all affected files
before deleting them, invalidate prepared exports, and allow subsequent events
to be logged. Preserve enrollment, conversations, pending requests, permissions,
other instances and unrelated files. Clean continues to preserve logs.

The CLI's existing 1 GiB limits apply to encrypted workflow stores, not its
diagnostic files. Its diagnostic default remains four 8 MiB files.
