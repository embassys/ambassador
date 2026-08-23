# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/product-vision-and-architecture.md`
2. `docs/implementation-plan.md`
3. Relevant accepted records under `docs/adr/`

If your task conflicts with these documents, stop and ask. Do not expand the scope on your own.

## Project rules

- Keep the sidecar content-blind and outbound-only.
- Never store task text, responses, permission details, grants, or MCP payloads.
- Write tests and configure CI before production implementation.
- Do not select or install any framework, library, runtime, package manager, database driver, or build tool without explicit user approval.
- Get user approval for the CLI interface before writing CLI tests or code.
- Get user approval for publishing and installation plans before adding distribution tooling.
- Record approved architecture and dependency choices under `docs/adr/`.
- Respect task dependencies and file ownership in `docs/implementation-plan.md`.
- Remote MCP implementation, ACP, hosted-agent connectors, and GUI work stay out of scope unless the product document changes first.
