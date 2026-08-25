# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/product-vision-and-architecture.md`
2. `docs/protocol-v1.md`
3. `docs/implementation-plan.md`
4. `docs/decisions-to-review.md`
5. Relevant accepted records under `docs/adr/`

If your task conflicts with these documents, stop and ask. Do not expand the scope on your own.

## Project rules

- One foreground gateway process owns one webhook target and one enrolled central identity. Do not add bindings, runtime discovery, agent IDs, general configuration, or native service management.
- `start` accepts only `--webhook-url=<url>` and `--webhook-token-env=<name>`. The webhook token also authenticates every request to the loopback MCP endpoint.
- Keep the notification journal ID-only. Never write task text, responses, permission details, grants, tool arguments, email addresses, verification codes, or MCP bodies to SQLite, configuration, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- A successful `verify_email` response is the only source of the central JWT. Intercept it before returning the tool result and persist it only through the approved credential store. It may appear transiently only as the injected `token` argument in an upstream MCP call or the central poll bearer header; never put it in local MCP arguments or results, URLs, the journal, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- Registration and verification are exempt from central JWT injection, but they are not unauthenticated locally. The MCP listener always binds to `127.0.0.1`, validates `Host` and `Origin`, and checks the webhook bearer token.
- Write tests and configure CI before production implementation.
- Do not select or install any framework, library, runtime, package manager, database driver, or build tool without explicit user approval.
- Get user approval for the CLI interface before writing CLI tests or code.
- Get user approval for publishing and installation plans before adding distribution tooling.
- Record approved architecture and dependency choices under `docs/adr/`.
- Respect task dependencies and file ownership in `docs/implementation-plan.md`.
- Follow the task gates in `docs/implementation-plan.md`. Do not install the proposed MCP SDK or implement production credential persistence before their ADRs are approved. A production central MCP implementation, ACP, hosted-agent connectors, and GUI work stay out of scope.
