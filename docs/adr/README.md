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

ADRs 0028 through 0031 were accepted on 2026-08-30 and complete D05. They fix
the startup and retirement interface, encrypted content-free state, execution
and recovery contract, fixed limits, runtime, dependency scope, private
package layout, platform qualification, installation model, and later
publishing gates. ADR 0032 permits K01 against the accepted G04 fixture
contract. Provider interfaces and public distribution remain behind their
separate ADR and release gates.

ADR 0032 was accepted on 2026-08-30. It permits contract-first local gateway,
connector, and provider implementation against the accepted independent
fixtures before the external central service is ready. Gate A, S07, combined
qualification, production activation, support claims, and publishing remain
blocked on their real evidence and approvals.

ADR 0033 was accepted on 2026-08-30. The initial gateway and connector release
supports macOS and Linux only. Windows is unsupported, implementation-plan task
W01 is closed as deferred rather than passed, and Windows CI may return only
under a new approved implementation and qualification plan.

ADR 0034 is accepted for the Codex-first preview implementation path. It pins
one Codex App Server release and generated schema and defines the Codex-specific
stdio, policy, recovery, history, authentication, containment, license, update,
and CX02 red-test contracts. It authorizes CX02 and, after the red failure
review, CX03. Later user review remains available but is not a blocker. The
record does not authorize publication, stable support, real-central
compatibility claims, or Windows support.

Accepted target architecture is not evidence that the central service has
implemented or deployed it. Until central owners provide production URLs and
deployment facts, tests use only the stand-ins in
`docs/v2-fixture-profile.md`. Never copy those test values into production
constants or cite a fixture result as proof of a real central transaction.
