# 0022 Development verbose transcript

Status: accepted

Date: 2026-08-27

## Problem

The hosted central MCP service has failed during live verification while the gateway returned only its safe generic error. That made the failure impossible to locate without a separate forwarding proxy.

## Decision

Temporarily accept this development-only startup form:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<name> --verbose=true
```

`--verbose=true` is valid only when both `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` are set. Omitting it keeps the existing safe output. No other value or spelling is accepted.

Verbose mode writes request and response transcripts to stderr. It may include email addresses, display names, tool arguments and results, message bodies, action data, and permission data. It redacts:

- webhook and central bearer tokens;
- values in fields named `token`, `jwt`, `access_token`, or `authorization`;
- `Authorization`, cookie, and webhook-signature headers; and
- verification codes.

The gateway does not write the transcript to a file. Users must assume their terminal, shell host, or desktop session may retain stderr. Verbose mode is unsuitable for production or support bundles.

## Removal

Remove the option after the hosted registration, verification, polling, and acknowledgement flow is stable and the central service returns useful machine-readable errors. `docs/development-todos.md` tracks this work.

## Tradeoffs

Verbose mode deliberately weakens the normal content-blind observability boundary. Restricting it to explicit development endpoints and redacting credentials limits the damage, but task and identity data can still appear in terminal history.

The change adds no dependency and does not alter the npm package layout.

## Approval

The user approved the temporary development-only CLI and logging exception on 2026-08-27 and asked for a removal TODO.
