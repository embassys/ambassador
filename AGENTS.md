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

- Keep the notification relay and its durable state ID-only.
- The combined process may handle MCP payloads transiently only inside the local proxy path. Never write task text, responses, permission details, grants, tool arguments, or MCP payloads to configuration, the journal, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- Do not expose an inbound internet port. A local MCP listener must bind to loopback, authenticate every caller, and map that caller to one fixed binding.
- Keep central JWT values out of configuration, URLs, MCP tool arguments and results, the journal, diagnostics, metrics, logs, temporary files, crash artifacts, and support bundles. A caller must not select another binding or credential through request data.
- Write tests and configure CI before production implementation.
- Do not select or install any framework, library, runtime, package manager, database driver, or build tool without explicit user approval.
- Get user approval for the CLI interface before writing CLI tests or code.
- Get user approval for publishing and installation plans before adding distribution tooling.
- Record approved architecture and dependency choices under `docs/adr/`.
- Respect task dependencies and file ownership in `docs/implementation-plan.md`.
- The local credential-injecting MCP proxy in ADR 0016 is in scope only after every G5 approval in `docs/implementation-plan.md`, followed by the required failing tests and G6 review. A central MCP implementation, ACP, hosted-agent connectors, and GUI work stay out of scope.
