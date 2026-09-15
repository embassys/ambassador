# Account history and Mac tests, September 15

The owner approved five follow-ups and a live Mac end-to-end test. This record
separates implemented changes, native sample-data checks, installed-provider
checks and unfinished live qualification. No server code, dependency, public CLI
argument, version or release changed.

## Account history

Reviewed central source `8c648d8920ad39f970c476cc63d4840c0a38be4d` and the deployed
OpenAPI before adopting `GET /api/owner/communications`. The route reads account
messages without consuming the agent queue. Its explicit retention metadata
prevents describing the available pages as a complete permanent archive.

The private owner worker requests pages of 50. Validation covers message IDs,
party ownership, direction, deleted senders, timestamps, cursors and retention.
Legacy call IDs remain bounded strings because the current server permits them.
Only this read route is called; history does not enter delivery custody or cause
an acknowledgement, result submission or action replay.

The sidebar groups messages by the exact central agent pair. It merges them
with a local peer session only when the match is unique and belongs to the
current local enrollment. It retains ambiguous or other-device conversations
separately. Message IDs remove duplicate incoming local entries while preserving
the local agent's replies and tool summaries. Internal account conversations and
deleted senders have explicit handling.

Older pages load on demand. Refresh retains overlapping older pages and updates
changed records. New nonoverlapping history replaces the previous view. Bounds
are 1,000 messages and 8 MiB in memory, within the existing 4 MiB per-response
transport limit. Repeated cursors fail visibly. Failed reads preserve the last
view with an error; sign-out and account changes discard the account view.

Native checks found and fixed two account-only details problems: Reload latest
messages initially did not refresh the central page, and its details sheet
incorrectly described local transcript retention. Both passed after correction.

## Native Mac evidence

The production renderer ran in Electron on macOS arm64. All clicks and
screenshots used native computer control. Sample-data screens are marked as
such in the app and must not be treated as live central delivery evidence.

Passed with controlled sample data:

- Mixed account/local history displayed the central request once, preserved
  local replies and tool activity, and retained the pending owner question.
- An account-only peer opened without requesting nonexistent local history.
- Loading an older page added the earlier result to the same conversation in
  chronological order. Refresh preserved that loaded result.
- Reload latest messages reset the page and restored the earlier-page control.
- Account-only details showed central retention and offered no local deletion.
- Details opened as a sheet; Escape returned focus to the invoking control.

The real isolated app also started its service, opened Register, sent a real
owner sign-in email and reached the code form against `https://mcp.embassys.ai`.
Mailosaur rejected the saved test credential with HTTP 401, so the code could
not be retrieved. No completed sign-in or new enrolled agent is claimed for
this run. A request for restored mailbox access or an owner-provided test
address remains pending. The existing user installation was left unchanged.

The isolated live app also passed native Stop server and Start server checks.
Its visible status changed from Running to Paused and back. The final copy
cleanup removes a stale Settings sentence that said account recovery was still
future work.

Screenshots are retained locally in `.build/account-history/screenshots/`:

| Files | Evidence |
| --- | --- |
| `01-welcome.png` through `03-one-code.png` | Real app and deployed sign-in, stopped before verification |
| `04-cowork-discovery-miss.png` | Fresh native Cowork chat missing the connector |
| `08-account-history-details.png` | Final account-only retention sheet, sample data |
| `09-account-history-final.png` | Populated account-only conversation, sample data |
| `10-combined-history-final.png` | Combined central/local conversation, sample data |
| `11-cowork-discovery-retest.png`, `12-cowork-app-setup-response.png` | Fresh chat still needed a connector hint; corrected tool response sent setup to the app |

## Installed agents and discovery

The bundled gateway checked actual installed agents against an isolated central
fixture. It temporarily configured each provider's normal Ambassador MCP entry,
then restored settings. The fixture registered once; connecting additional
providers did not repeat registration. This tests tool access through real
providers, not live email onboarding or native Connect dialogs.

| Provider | Result |
| --- | --- |
| Codex | Verified by the expected MCP challenge |
| OpenClaw | Verified by the expected MCP challenge |
| Hermes | Verified by the expected MCP challenge |
| Claude Code | Provider reported an expired OAuth session that could not refresh; no verified check |

The temporary Codex model preference and all provider MCP entries were restored.
No provider credential was copied or changed. Evidence is in
`.build/account-history/providers-configured.json` with credential-redacted
diagnostics beside it.

A fresh native Sonnet 5 High Cowork task did not discover the integration from
"Am I registered with Embassys?". After "Use the Embassys connector", it called
the tool but received the old generic `not_enrolled` response and offered the
wrong CLI enrollment flow for an app-owned instance. The client now supplies
Embassys discovery text on every relevant desktop tool and directs all known
unenrolled tools to the app. Initialization gives the same app-owned guidance.
CLI-owned enrollment remains unchanged. Tool names and input schemas are
unchanged. Tool text cannot force a host to search its connectors.

A second fresh Cowork task tested the rebuilt gateway and relay. It still asked
what Embassys was before searching. After the same short connector hint and a
one-time read-only approval, it correctly directed the user to sign in and set
up the device in the Embassys app. It explicitly declined to collect a code in
chat. This verifies the app-owned guidance fix while leaving initial discovery
unresolved. The temporary desktop connector entry was removed afterward.

## OpenClaw and Hermes return paths

Reviewed current OpenClaw source `aa0f68eca54668e88ee5044d5332fdd3c332966d`.
Its duplicate grouping function still mutates a retained item's count. Running
that unchanged function three times over the same plain text fixture produced
counts 2, 3 and 4. Imported identity and normalization helpers were stubbed, so
this is a focused source reproduction, not a fresh native message-injection
test. The existing native bridge remains experimental. Expand the grouped work
row to see saved messages; foreground tool waits remain the default.

Reviewed Hermes source `3ba5602b6273f9bb0d2a0d52c77bbe0f50f6227b`. Its plugin
injection still requires a trusted gateway session key and supports interrupting
injection. The tool hook supplies a session ID, not that key. An accepted
injection does not prove visible delivery, and there is no qualified atomic
idle-only return path. Do not infer a destination or inject into a busy chat.
Foreground waits and durable user-driven checks remain the supported path.
Source-review evidence is in `.build/account-history/provider-review.json`.

## Qualification helper and automated checks

The old archive inspection limit rejected the current package before tests ran.
It now permits 1,024 entries while preserving the 64 KiB listing bound, rejecting
duplicates, traversal, control characters and entries outside `package/`.
Regression tests include a package list larger than the former 256-entry limit.
The actual candidate passed archive inspection and reached all four providers.
That full delivery run did not qualify: its central/webhook fixture prerequisites
were absent and its provider probes were not observed. The separate configured
agent check above provides the passing connection evidence.

- Repository check: 608 passed, six expected skips, zero failures.
- Desktop artifact/render checks: 47 passed.
- Desktop typecheck and production build passed.
- Bundled Node, SQLite, ACP dependencies and the real MCP worker passed with an
  isolated executable search path.
- Focused history, relay and app-owned registration tests passed.

Regression cases cover overlap, equal timestamps, cursor cycles, bounds, stale
owner replies, invalid direction/identity pairs, deleted peers, internal traffic,
ambiguous local matches, incoming deduplication, retention and app-owned setup.
Existing shared-flow coverage remains in the core suite; no redundant full
platform matrix was added.

## Remaining live acceptance

The PR review also reproduced an older-page selection bug using a peer absent
from the recent page. Opening that conversation discarded its loaded messages.
Conversation selection now preserves the loaded pages; only the explicit
"Reload latest messages" control resets them. A native Mac check loaded Casey
Ellis's older result, opened it, switched to Alex and returned to Casey with the
same result still visible. This used the sample app, not the deployed API.

Before the PR, shared core checks passed with 586 tests and four expected skips;
Mac platform checks passed with 22 tests and two expected skips. All 53 desktop
artifact, render and modal lifecycle tests passed, together with desktop
typechecking, the production build and repository lint. Request dialogs were
also checked in the native sample app for cancellation, focus and scroll
restoration, nested details, long choices and a completed answer.

After mailbox access is restored, resume the isolated profile with a fresh code:

1. Verify one owner email and use the native Connect dialogs for Codex, OpenClaw
   and Hermes. Confirm each check and prove additional connections send no
   registration or verification email.
2. From a second controlled identity, queue an action. Read its communication
   history repeatedly before the executor receives it. Then prove ordinary
   agent reception and completion still work, with the same message/call IDs.
3. Observe the actual request and result in the app, exercise owner input,
   refresh, quit/relaunch and a temporary offline read, and capture populated
   native screenshots. Confirm execution and history remain independent.
4. Restore provider settings and stop the isolated service. Keep the user's
   existing installation and provider history intact.

Claude Code requires its provider login to be restored for another connection
test. The prior September 14 native Claude onboarding success is recorded in
[the one-code report](one-code-onboarding-2026-09-14.md); it is not a substitute
for these unfinished September 15 checks.
