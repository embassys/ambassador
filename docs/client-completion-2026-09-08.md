# Client completion, September 8

The owner requested the remaining work except central API changes and
distribution. Native Windows/Linux testing remains deferred. This record
separates completed live checks from the provider and account prerequisites.

## Combined native and real-agent flow

The unsigned Embassys Mac app registered a fresh disposable identity against
`https://mcp.embassys.ai`, verified its emailed code, completed owner email login,
and connected the owner's existing Claude Code entry. The central source review
used revision `a8c0e77e0a5bb6897ed842a7288a458124fd298c`; the deployment does not
expose its revision. No central code changed.

A fresh Claude Code Mac conversation, Sonnet 5 with High effort, received only:

> Can you get the phone number of live-qualification-contact-5f82561a@zzncpfab.mailosaur.net from their agent?

Claude discovered the catalog and requested `get_phone_number` without a website
question or tool hint. The target owner accepted the actual offered permission
choice through the emailed decision. The target was real OpenClaw ACP 2026.8.2,
using its installed provider authentication and its normal Ambassador connection
on port 9797. The Claude instance remained on 8787.

OpenClaw asked its owner for the exact phone number. The test answered the
correlated email with synthetic number `+44 7700 900839`. The answer resumed
session `a7d2be9b-c4d3-4409-9e4b-c094468fd303`. OpenClaw submitted the result;
Claude's original conversation displayed the exact number and acknowledged it.
Request `4d807072-1af5-4f60-9024-ef260d003131` completed with explicit receipt at
08:56:42 UTC. This run qualifies a wait across owner input, not a new ten-minute
timeout measurement. The existing 600-second qualification remains separate.

The first attempt failed because the test helper supplied `allow_once` where
the email offered `accept` and `deny`. Central refused it. No action was executed.
The helper had also discarded that email too early. The corrected test checked
the offered choices first and deleted emails only after a successful response.
The first pending request remains a disposable test record, not a product
success. A text-answer helper mistake similarly sent `value` instead of `text`;
central refused it before consuming the token, and the corrected text succeeded.

Native screenshots are retained locally under `.build/client-completion/`:

- `01-welcome.png` through `06-existing-connection-accepted.png` show app signup
  and guided setup.
- `08-claude-final.png` shows the successful natural request and exact answer.
- `09-embassys-conversation.png` shows the reverse test's saved conversation.
- `action-evidence.json` records tool status, resumed session and receipt.
- `reverse-result.json` records the opposite-direction exact result.

The earlier `07-natural-request.png` belongs to the failed helper attempt. It is
not evidence that the first request completed. Provider history contains only
the controlled test conversation and whatever the provider normally retains;
Ambassador did not read or copy provider credentials.

## Instance isolation and existing settings

Stopping and cleaning the disposable OpenClaw instance left the Claude server
running with its original enrolled identity. OpenClaw was then enrolled as a
new disposable identity. Both instances ran together throughout the corrected
action flow.

An opposite-direction request, submitted by the test MCP driver on port 9797,
reached real Claude ACP 0.73.0 on port 8787. Claude returned its different
synthetic number, `+44 7700 900838`. Its own tool approvals used the exact offered
`allow-once` ID through the owner email path. The driver received and acknowledged
the result. This second test qualifies the opposite executor binding, not a
second native OpenClaw requester UI conversation.

These checks cover two different installed providers and independent instance
lifecycles. They do not provision two isolated profiles of one provider, pin
cached provider connections, or qualify different engine versions. Trusted
engine installation still belongs to the excluded distribution work.

The test exposed an onboarding conflict for the valid existing Claude entry
`{ "type": "http", "url": "http://127.0.0.1:8787/mcp" }`. ADR 0073 shares the
strict public connection validator with the executor check. Setup accepts this
entry without changing it or taking ownership. An app-owned entry that the
owner edited remains protected from automatic removal. Regression tests cover
all four providers, wrong endpoints, unsupported fields and ownership.

An open Conversations view also retained an old empty list after delivery.
The view now refreshes its bounded session list every five seconds while the
server and visible local view are active, and offers manual refresh. Refresh
preserves the selected transcript and pagination. Reads never overlap, errors
keep existing content, and closing or switching the view discards late results.
Tests exercise each asynchronous boundary before the UI implementation.

Cleanup also caught a transient sign-out warning. The worker correctly saved an
unconfirmed marker before contacting central, but exposed that marker as a
failure while the successful request was still running. The public snapshot now
shows local sign-out immediately and reports uncertainty only after failure.
Crash recovery still retains the marker, and a failed response never restores
credentials. Regression coverage checks both the in-flight snapshot and persisted
state against the reviewed success response, including its optional message.

## Fresh Codex discovery

Fresh desktop task `01a0803c-601c-7751-abff-913d4b1d7975`, titled
"Check Embassys registration", received only "Am I registered with Embassys?"
through the app's task creation API. It called Ambassador `get_my_permissions`
and confirmed the exact test email and active verification. No website question,
tool hint, registration retry or inherited test conversation was needed.
The recorded task completed in 17 seconds. This is transcript and tool-call
evidence; it is not a Codex screenshot or a manually typed UI test.

The temporary public MCP entry used the existing guarded configuration helper
and a 660-second tool timeout. The current [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
describes shared local MCP configuration and initialization instructions for
tool discovery. The existing initialization guidance already names Embassys in
its first paragraph, so this test required no new prompt workaround.

## Remaining provider and account boundaries

Hermes source `e95dd466b120d013f53e48f11785fb01466e6587` still does not satisfy
the approved native-return contract. `hermes_cli/plugins.py:1973` documents
interrupting an active CLI turn. Gateway injection needs a trusted existing
session key and reports queued acceptance. Its tool hooks expose a session ID,
not the required gateway-origin contract. `gateway/wake.py` describes a separate
API turn with no per-session lock, so competing writes can replace session state.
Keep foreground waits and durable checks. A future bridge needs a public trusted
route, idle-only delivery, and an observable final outcome; do not infer those
from private state or asynchronous acceptance.

OpenClaw's September 8 native retest already reproduced the duplicate badge and
hidden waiting text while saved history contained one answer. The duplicate
badge also appeared before any Ambassador injection. Keep return experimental.
The current investigation does not establish the renderer's exact defect or a
safe Ambassador-side correction. Changing saved text or sending another result
to hide the badge would invalidate the delivery evidence.

Native Calendar currently lists only "On My Mac". Invitation delivery remains
pending the owner's chosen sending account. Claude Chat also shows a connected
Google Calendar connector; the owner has been asked whether to use that account
for one disposable test invitation. No account or recipient was guessed.

## Standalone Claude Chat and Cowork

ADR 0074 adds a local stdio client using the existing MCP SDK. It preserves the
six-tool catalog, exact requests, progress, waits, errors and receipts. It uses
the truthful `embassys-desktop-relay` identity and connects only to the owner's
selected loopback port. Registration and incoming executor choice stay in
Embassys. It never acknowledges or replays an operation itself. Both per-request
cancellation and caller shutdown cancel observation, and cancelling one wait
leaves the connection usable for later reads.

Claude Desktop 1.46388.4 loaded the client through its local Developer config.
The test used bundled Node with the compiled source module; packaged-module
verification is separate. Changing configuration while Claude was running was
overwritten on exit. The corrected setup quit Claude first, changed only the
temporary Ambassador entry, then restarted. The existing Claude Code connection
and unrelated settings were preserved. Manual source-build instructions are in
[the local client guide](claude-desktop-local-client.md); MCPB packaging and
automated installation remain excluded distribution work.

A fresh Sonnet 5 Cowork task initially searched the connector directory and
missed the existing `ambassador` connection when asked about "Embassys". Manual
standalone setup now names its connector `embassys`, matching the product.
After restart, fresh task `cse_01SYL6p4WYotfqP8HwZUZeph` found it without a tool
hint and returned the saved request's pending status. Its first inbox attempt
included an unsupported `wait_seconds` field; strict validation rejected it and
the model corrected the read. This is observed recovery, not a guarantee that
every model will discover every connector. Existing executor and hook names
remain unchanged. Another fresh Sonnet task,
`cse_01FhTTTk4j44atLpQt5guQ58`, still asked where to find Embassys, despite the
connector being enabled in its native menu. Discovery remains intermittent;
the naming change alone is not a complete remedy. The final continuation trial
explicitly names the connector and is labelled as guided qualification.

In standalone Chat, Opus 5 High received the same natural phone-number request
as the earlier Claude Code test, without a tool hint. It discovered the catalog,
requested the exact action, received real OpenClaw's `+44 7700 900839`, and sent
its own explicit receipt. Chat displayed the exact number in conversation
`1500d9ad-c32d-4c97-b967-e375ee86a694`. Request
`3f9a2c14-7b8e-4d61-9a03-5c2e8f41b7d6` remained open for 94,531 ms; central's
polling timeouts delayed receipt but the receiver recovered without replay.
The existing standing grant applied, so this run did not test a new grant email.
Claude's local tool approvals used Allow once.

Cowork, also Opus 5 High, independently received the same natural request in
`cse_01V6b1xCYayhoEbvP3HnmVoS`. It read the catalog and enrollment, made request
`ef39ef8d-37ab-4a7a-aa6e-1d1dc3365565`, and displayed the same exact result after
an explicit receipt. The action call remained open for 44,040 ms. Cowork kept
working while the native window showed a separate Chat conversation. These are
separate native display checks, not inherited Claude Code qualification.

Screenshots `12-claude-chat-final.png` and `13-claude-cowork-final.png` show the
actual native answers. `standalone-evidence.json` retains the correlated tool
requests, returned results and receipts. Full deadline checks against the old
pending operation exposed different host ceilings. Chat cancelled after 240,009
and 240,007 ms; Cowork cancelled after 180,007 ms. The first Chat interruption
was initially suspected to be the operator's Escape key while dismissing a menu,
but correlated cancellation timestamps and the untouched repeat establish the
four-minute host limit. Chat's native message suggested the server could have
crashed, although the gateway remained healthy. No new action was submitted.

The relay first gave fixed initialization and tool-level guidance to supply
`wait_seconds: 150` for waiting operations in these standalone clients. Cowork
ignored initialization-only guidance in a further trial, so the same limit and
request ID help are also present in the tool description and parameter help.
It still forwards exact arguments and preserves every schema validation
constraint. The shorter explicit
wait uses the already accepted known-client-timeout exception; it returns a
normal pending result with the same operation's continuation, without an
automatic retry or a false failure claim. A longer upstream budget alone cannot
override either host's deadline. `14-chat-host-timeout.png` retains the native
failure before this guidance. Chat's subsequent Sonnet 5 guided check in
`c6d2e5f4-486d-4b53-9f2d-ee5a8f3cb3e3` displayed a normal pending answer after
150 seconds and ended without retrying; `15-chat-pending.png` records it.

Cowork's guided 150-second check in `cse_01BWneygcj4TWfamMuFkV1qc` exposed a
second deadline. The local MCP call completed after 150,003 ms, but Cowork
reported a 60-second timeout reaching the desktop. `16-cowork-bridge-timeout.png`
records the native failure. A successful local response therefore did not
qualify this host path. The shared standalone tool help now recommends 45
seconds, below that observed bridge deadline. This is conservative for Chat,
which already passed a 150-second pending reply. Neither host is claimed to
support a full ten-minute call through this connector.

The final guided Cowork trial, Opus 5 High in
`cse_01VnqpUmmv7AiYuevVdJUYZ2`, selected 45 seconds itself from the tool help.
It received `pending` after 45,001 ms, displayed a normal "no update yet" answer,
and ended without another check. `17-cowork-pending.png` records the visible
answer. These guided deadline tests supplement the earlier natural phone-number
tests; they do not erase the fresh-discovery failures.

## Cleanup and validation

All temporary Codex, OpenClaw and standalone Claude entries were removed using
ownership/content checks. OpenClaw's gateway was restarted, and Claude reopened
with its original settings. The owner's existing Claude Code HTTP entry was
unchanged. The test Embassys host exited cleanly, both 8787 and 9797 listeners
closed, and only the disposable profile was removed. The local screenshots and
sanitized qualification evidence remain in `.build/client-completion/`.
The original Personal app is restored, signed out with its server stopped. The
temporary wake lock was stopped; no permanent screen-lock setting changed.

Validation passes 494 core tests with seven expected skips, 18 desktop tests,
lint and typechecking. The rebuilt unsigned Mac package passes the actual worker
and bundled stdio-client probe with isolated PATH, duplicate native host launch,
and packaged CLI → app → CLI handoff with restart. The packaged relay is byte-for-byte
identical to the live-tested compiled module. No central API changes,
distribution or release were performed. The baseline `37ed888`
also passed all three desktop CI jobs in
[run 34203928949](https://github.com/embassys/ambassador/actions/runs/34203928949).
That CI run does not qualify subsequent changes in this record.


## Subsequent owner decision on wait policy

After reviewing these measurements, the owner explicitly chose to keep the
ten-minute default even when Chat or Cowork ends observation earlier. ADR 0075
supersedes the 45-second recommendation. Initialization and tool help retain
continuation instructions before dispatch; no reply can be delivered over a
connection after the host closes it. The test results above are historical
measurements, not a claim that either host now holds ten minutes.
