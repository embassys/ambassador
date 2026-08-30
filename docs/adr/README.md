# Architecture decisions

Put each architecture or dependency choice in its own file.

Do not mark a decision accepted or install the corresponding software until the user approves it.

Use a name such as `0001-typescript-runtime.md`. Include:

- A status of proposed, accepted, rejected, or superseded.
- The problem to solve.
- Options considered.
- A recommendation with reasons.
- Tradeoffs and operating costs.
- Maintenance status and license.
- Effects on packaging and supported platforms.
- User approval and date.

Read the accepted decisions that affect your task before writing code. If a choice changes later, normally add a record that supersedes the old one. Obsolete records may be deleted only when the user explicitly asks to remove them; Git history remains the archive.

ADRs 0023, 0025, 0026, and 0027 were accepted on 2026-08-29. They define the
target REST enrollment, version 2 conversation and recovery, DPoP contracts,
and fresh-install-only cutover.

ADR 0024's provider-neutral connector boundary was accepted on 2026-08-30. It
keeps provider control in separate foreground companions, leaves the gateway
and its CLI provider-neutral, assigns one connector to one gateway and provider
pair, uses the ID-only webhook wake plus authenticated local MCP retrieval, and
keeps content-free correlation in connector-owned state. Central and provider
credentials do not cross that boundary, and an uncertain provider turn is not
replayed blindly.

ADR 0024 does not approve the connector CLI, state implementation, limits,
runtime, dependencies, provider port, policy, packaging, installation,
supported platforms, or publishing plan. Those decisions require separate
records and user approval before tests or production code.

Accepted target architecture is not evidence that the central service has
implemented or deployed it. Until central owners provide production URLs and
deployment facts, tests use only the stand-ins in
`docs/v2-fixture-profile.md`. Never copy those test values into production
constants or cite a fixture result as proof of a real central transaction.
