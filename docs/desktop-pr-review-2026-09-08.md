# Desktop PR review, 8 September 2026

The owner requested Cowork discovery investigation, an OpenClaw display fix or
workaround, a real calendar invitation using the connected Google Calendar, and
review and merge of [PR 40](https://github.com/embassys/ambassador/pull/40).
This work does not authorize a release or change the central API.

## Cowork discovery

Claude Desktop 1.46388.4, Sonnet 5 High, used a temporary local `embassys`
connection and an enrolled disposable gateway. Central and the recipient were
fixtures. The gateway remained available throughout the discovery trials.

A fresh Cowork task received only "Am I registered with Embassys?" and asked
what the product was instead of searching its tools. The follow-up "Use the
Embassys connector" loaded `get_my_permissions` from that same connection and
returned the registered, verified fixture identity. This separates a discovery
miss from a missing connector or a failed enrollment.

The desktop relay put its long waiting guidance ahead of the product description.
Its description now leads with Embassys and what the connection does, retaining
the six tool names and exact request validation. A regression checks that the
product and agent purpose remain near the beginning. A fresh repetition of the
same registration question still missed the connector after restart. Metadata
cannot force a model to search its available tools.

A separate fresh task received the ordinary phone-number prompt without a tool
hint. Sonnet refused on a privacy assumption before using tools. The test contact
was synthetic and the service requires its owner's permission; this trial is
recorded as a failure to discover the supported consent flow. It does not revoke
the earlier successful Opus 5 native Chat/Cowork qualification. Client claims must
include the model and whether a tool hint was supplied.

A follow-up identified the disposable test contact and asked for the connected
Embassys permission flow. Cowork then read enrollment and the catalog, requested
`get_phone_number`, checked the same request after permission progress, and
acknowledged the final event. The native view displayed `+44 7700 900728` and a
separate observer confirmed the operation completed with an empty inbox. All
business waits omitted `wait_seconds`. Request
`9d21ccf6-d4e0-47c8-a7b2-ec1f7761efbe` was not resubmitted. This is guided fixture
qualification. The final prose attributed approval to the other agent; the
fixture actually exercised the human-decision endpoint. That wording is another
model-level limitation, not evidence that an agent can grant permission.

The practical workaround is "Use the Embassys connector". Keep app-owned login
and do not ask the owner to register again just because Cowork asks for a website.
Do not publish the loopback server as a remote connector. Anthropic's
[connector documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
says local MCP servers are unavailable in Cowork, while these installed-client
tests reached the local relay. Treat that discrepancy as a version-specific
qualification limit, not a reason to invent another transport.

Task records:

- Baseline and guided enrollment read: `cse_01NyhbKshS6MN1SQDPhpXdAC`.
- Fresh enrollment question after metadata change: `cse_01XXARcMMgG7oT4YASe7HTHk`.
- Natural phone request: `cse_017Ugr5LPHi64kMK9mu3qRCf`.

## OpenClaw display

The installed OpenClaw Mac app is 2026.8.2, build `0965053`. Its bundled web
Control UI renders the tested conversation. The Swift chat renderer is a
separate code path and does not explain this screenshot.

The earlier waiting reply was retained in the native conversation. After the
late answer arrived, OpenClaw folded that reply into "Worked for…". Expanding
the section exposed the exact pending status above the final phone number.
A blank native view also repainted after resizing. Both workarounds were checked
in the actual app and saved as screenshots. No message, receipt or action was
sent during this display inspection.

The bundled `chat-thread-grouping.ts` explicitly selects the last visible
assistant group as the final reply and collapses preceding work. That accounts
for the hidden waiting message. `chat-thread-duplicates.ts` also changes the
input item's `duplicateCount` while grouping. An isolated execution of its
unchanged grouping function with two identical unkeyed text rows returned counts
2, 3 and 4 across three passes. Normalization and identity helpers in that probe
used plain text fixtures. This proves the counter is not idempotent; it does not
prove every step that caused the original live badge. The live history contains
one injected answer, and earlier registration also showed a badge before any
Ambassador injection.

An upstream correction should compute duplicate counts in fresh presentation
objects and test repeated grouping plus streamed-to-saved identity reconciliation.
The status layout also needs a distinct boundary for independently injected
answers if the provider wants earlier terminal replies to remain expanded.
Ambassador must not rewrite provider history, change the answer to defeat
comparison, or inject another answer to hide the badge.

Keep foreground waits as the default and native return experimental. Expand
"Worked for…" to inspect waiting status, resize a blank Mac window, or ask for a
check of the saved request. Disabling the optional return extension leaves the
foreground and durable-check paths available.

## Real calendar invitation

With the owner's approval, native Claude Chat used the already connected Google
Calendar to create one disposable event and email the test recipient. The prompt
specified 9 September 2026, 10:00–10:15 Europe/London. Claude first called the date
Tuesday; the confirmation corrected it to Wednesday before creation. Both create
and delete tool approvals used Allow once.

The recipient inbox received the invitation. Its calendar attachment matched the
exact attendee, title and time, including the London timezone. Claude then
deleted the event and the inbox received cancellation for the same event UID.
The invitation used London local times; cancellation expressed the same interval
as 09:00–09:15 UTC. Assertions checked both forms and the shared UID.

This proves real invitation delivery and cleanup through the connected calendar
provider. It is separate from the earlier agent-to-agent availability,
coordination and denial tests; this run did not repeat the whole Embassys
scheduling chain.

Native conversation: `c7a58939-cc12-41da-8b5e-1f47cbef6a69`.
Local evidence is under `.build/client-final-review/`, including
`calendar-sent.png`, `calendar-cancelled.png` and `calendar-verified.json`.
Mailbox content and provider details are excluded from the repository.

## Code review and validation

Reviewed desktop IPC trust and schema boundaries, renderer isolation and
navigation restrictions, worker startup/shutdown, owner decision review and
revalidation, durable mutation markers, notification deduplication, provider
configuration ownership and Clean confirmation. The owner flow uses the existing
owner REST API and keeps its credential separate from the enrolled agent.
Uncertain submissions retain their markers and cannot be automatically repeated.

The review corrected stale guidance claiming there was no approval UI, removed
remaining advice to shorten waits because of a host timeout, and corrected setup
copy that treated standalone Claude as wholly unqualified. The ten-minute default
and later user-driven checks remain unchanged. Tests failed on the stale metadata
and wait wording before the fixes and passed afterward.

Core checks pass 503 tests, with seven expected skips. The focused MCP and
workflow run passes 34 tests. Desktop type, rendering, parser and artifact checks pass, including 19 tests.
The bundled Node, SQLite, ACP dependency, real MCP worker and local desktop
client probe pass with an isolated PATH. The PR's Linux, macOS and Windows
checks must pass before merge. CI artifacts remain unsigned development packages. Platform qualification,
signed distribution and the central follow-ups in the work plan remain excluded.

The first full Windows PR run reached the existing 25-minute job limit after
357 passing tests, with no assertion failures. It was still progressing through
the suite when CI cancelled it. Native ACL tests retain their serial execution;
the Windows check job now has a 45-minute budget for the expanded suite. Other
platform budgets, test selection, audits and required publication gates remain
unchanged. The workflow regression checks both serial execution and the budget.

The Windows core suite subsequently passed, including its separate native ACL
checks. A duplicate desktop job first failed when GitHub rejected artifact
finalization with HTTP 403. Its retry passed the desktop tests but reached the
archive verifier's 60-second extraction deadline; `tar.exe` was terminated with
no reported extraction error. Windows archive extraction now has a bounded
three-minute allowance. Checksum, inventory, extracted-runtime verification and
cleanup remain required. This changes the development verifier only.
