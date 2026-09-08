# Embassys app implementation and test plan

Status: approved implementation sequence under [ADR 0064](adr/0064-desktop-application.md).

Date: 2026-09-07. The user authorized implementation and the recommended desktop
stack. The user subsequently named the app Embassys and removed CLI import
and migration from scope. Central implementation, new public CLI flags and
release remain separate.

## Progress on 2026-09-07

The approved design was pushed to main in `3a60187`. Initial implementation is
on `codex/desktop-app`; this is not a release candidate.

- Implemented the private Electron/React workspace, versioned IPC, standalone
  Node worker, private instance registry and start/stop/clean service boundary.
  Added views for manual agent setup, existing sessions/history previews, recent
  diagnostic events and instance settings. Owner-dependent views state that they
  are unavailable.
- Built an unsigned macOS Apple silicon package with official Node 24.19.0 and
  the existing engine, including its native SQLite and bundled ACP dependencies.
  The unpacked app is about 991 MiB. The Codex and Claude native dependencies
  account for about 462 MiB; do not claim a small installer yet.
- Passed the bundled runtime/MCP probe with an isolated executable path. Passed
  actual Electron host startup, duplicate launch and shutdown using a temporary
  profile, both from the development bundle and the packaged macOS app. A failing startup check caught a top-level ESM readiness deadlock;
  the host now registers an asynchronous readiness callback.
- Full repository validation passed: 355 tests passed, 7 environment-dependent
  tests skipped, no failures. Nine desktop foundation/worker cases cover IPC
  bounds, isolated real MCP servers, stop/clean, port and lock conflicts, registry
  races/corruption, storage binding and parent-disconnect shutdown. Desktop
  typechecking also passed.
- The packaged build and real host probe passed on macOS, Windows and Linux in
  [run 34102535495](https://github.com/embassys/ambassador/actions/runs/34102535495).
  Earlier failures caught missing Windows author metadata, Ubuntu sandbox-helper
  permissions and an executable path containing spaces. Linux packages now use
  a space-free directory; sandboxing remains enabled. This does not qualify a
  native Windows or Linux user desktop.
- Native macOS checks observed the window, accessible controls and real server
  state. Created an isolated instance on port 8788 without stopping the existing
  service on 8787. Filtered its real events, previewed two records and saved a
  metadata-only export with the native save dialog. Reviewed Clean's identity
  and work counts, then cancelled; the instance remained stopped and intact.
  Closing the window disposed the renderer. Tray interactions, a screen-reader
  session and resource-budget qualification remain open.
- Added bounded log filters and pagination across all rotated files, explicit
  body inclusion, export preview/save and reveal-folder controls. Custom storage
  uses the native directory picker. Instance creation has a stable request ID;
  reopening the window retains the selected view and instance.
- Clean now stops the selected instance before reviewing its identity and stored
  work. A five-minute exclusive-lock preview prevents changes before confirmation.
  Cancel releases custody and leaves the server stopped. The dialog distinguishes
  saved records from unfinished actions and explains the central re-registration
  limitation. Gateway crash recovery is capped at three attempts, with 2, 8 and
  30 second delays; it does not resubmit the interrupted command.
- Added the encrypted visible transcript archive and bounded session pages.
  Streaming text is normalized, provider replay and private reasoning are excluded,
  interrupted turns and storage gaps are labelled, and settled bodies expire after
  30 days. Local history deletion leaves workflow custody and provider history
  untouched. Provider previews are labelled separately from saved content.
  Archive capture is now covered with the mock ACP provider; native archive and
  real-provider qualification still need the updated package.
- The latest full local check passed 369 tests with seven expected skips, including
  encrypted group indexes, transcript normalization/Unicode/pagination/retention,
  quota gaps, stopped-instance history, Clean custody and bounded worker recovery.
  This check predates the remaining connection and performance work.
- Follow-up checks pass 385 tests with seven expected skips. Desktop CI now runs
  the complete desktop suite plus encrypted groups, visible transcripts and mock
  direct delivery, rather than only the initial foundation and worker cases.
  New cases cover temporary key derivation, release of idle workers, Clean review
  during background reads, missing credentials, GUI launch paths and startup settings.
- Commit `f859fb1` passed the expanded tests, package builds and actual host
  start/duplicate-launch/stop probes on macOS, Windows and Linux in
  [run 34110440688](https://github.com/embassys/ambassador/actions/runs/34110440688).
  The preceding run exposed a test cleanup order that deleted an open SQLite file
  on Windows. All transcript fixtures now close the archive before deleting their
  directory. Early window requests also wait until host IPC and assets are ready.
- The packaged background host measured 165.0 MiB physical footprint and 0.10% of
  one CPU core over a ten-second idle sample on an Apple M1 Max, Darwin
  25.6.0, arm64. This includes all five app-owned processes and one unenrolled
  instance, with no provider running. Electron can prewarm a renderer even when
  there are no BrowserWindows. The check includes its memory. It uses macOS
  `footprint`, not the sum of RSS values. Evidence is generated by
  `verify:package --measure-memory` in `.build/desktop/host-resource-qualification.json`.
  Enrolled/active workloads, window startup latency and native Windows/Linux
  resource measurements remain open.
- Moved desktop key derivation into a bounded short-lived helper and retired
  idle/failed workers. A stopped read cannot release an active Clean review.
  Clean refuses to report zero work if identity credentials are missing alongside
  encrypted stores. The credential format remains compatible with the CLI.
- Added opt-in launch-at-login controls. Windows and Linux implementations have
  fixture coverage, including modified startup entries and OS-disabled settings.
  The unsigned Mac preview reports the feature unavailable. No actual user login
  setting was changed, and OS logout/login qualification still needs installed builds.
- Verified Codex, Claude Code, OpenClaw and Hermes version commands with a
  Finder-like minimal PATH and fixed installation fallbacks. This confirms local
  executable discovery only, not a provider action or original-chat delivery.
- Opened API issues [7](https://github.com/embassys/agent2agent/issues/7),
  [8](https://github.com/embassys/agent2agent/issues/8),
  [9](https://github.com/embassys/agent2agent/issues/9) and
  [10](https://github.com/embassys/agent2agent/issues/10). Existing recovery issues
  1–6 remain in scope. No API code changed.

- Named the app Embassys across native menus, window, tray, package/executable,
  process labels and startup identity. It creates its own app data. The user
  removed CLI import and migration from scope; old installations are untouched.
- Native Mac checks passed for custom storage selection, independent port 8788,
  saved instance selection and stopped-state persistence. The new-instance form
  now skips occupied saved ports after a restart. The first suggested port was
  previously reset to 8788 even when another instance already used it.
- Opened and captured encrypted archive content in the actual Mac window after
  restart, using labelled synthetic complete/partial turns. This qualifies the
  display and offline read path, not a real provider conversation. Test identity
  and history were removed afterward; no synthetic identity remains enrolled.
- Fixed native keyboard Quit leaving a hidden host after its window closed.
  Final termination now waits for a later event-loop turn. Repeated Quit cannot
  bypass server cleanup. Native Stop followed immediately by keyboard Quit and
  idle keyboard Quit both exited with no remaining host; regression tests cover
  deferred exit, repeated requests and failed cleanup.
- Added guarded Claude Code Connect. The installed CLI writes only a new fixed
  MCP entry after native review, with a 660000 ms timeout. Conflicting existing
  entries are refused. Tests cover malformed/oversized/linked configuration,
  changes during review, expired previews, cancellation, lost command response,
  false success and preserving unrelated settings. Quit terminates setup work.
- Native Mac setup in an isolated Claude profile passed Cancel, Connect and a
  repeat check. The actual saved endpoint/timeout and unrelated settings were
  verified. Normal provider configuration was untouched. Evidence includes
  `.build/desktop-design/native-setup-result.json`, `embassys-native-setup.png`
  and `embassys-native-history.png`. Configuration success is not a live agent
  conversation or original-chat delivery test.
- The current full local check passes 395 tests with seven expected skips.
  Desktop typechecking, packaged build and actual host probe also pass. Code
  commit `dfbb8ec` passed the desktop tests, package builds and actual host probes
  on macOS, Windows and Linux in
  [run 34123765678](https://github.com/embassys/ambassador/actions/runs/34123765678).
  This does not qualify a native Windows/Linux desktop or provider session.

### Native polish and live app qualification

The next development candidate adds the supplied blue/purple brand as a vector
asset and packaged icons. It uses native window controls, system fonts, compact
platform spacing, Mac sidebar vibrancy and Windows Mica. Light, dark and system
appearance persist locally. The native Mac welcome and dark settings view have
been observed; Windows/Linux visual qualification remains open.

Claude Code and OpenClaw now share guarded Connect, Check, Repair and Disconnect.
The app records ownership of its exact public MCP entry without copying unrelated
provider configuration. Tests cover stale reviews, expiry, aliases, conflicting
ports/profiles, modified entries, cancellation, lost command responses and false
success. The old Claude-only helper was replaced, and its boundary cases moved
to the shared suite. Actual installed Mac CLIs passed Connect for both providers,
OpenClaw Cancel/Disconnect and Claude repair after a test-only external removal.
Unrelated settings and normal user provider profiles were preserved. Automatic
setup is enabled only on the qualified Mac arm64 platform; other platforms retain
manual setup until their installed-client checks pass. The private command also
enforces that boundary, including Windows npm shim limitations.

A packaged app with two fresh, isolated identities passed two phone-number
requests through the deployed central API and a real Claude ACP executor.
Both returned the exact synthetic number and received an explicit caller receipt.
The requester was a script; permission and provider decisions used the real email
flow with allow-once choices. This is not qualification of owner sign-in or
approval controls inside the app, or of a natural requester desktop conversation.

The native Conversations view displayed the first completed Claude turn, then
retained it after restart. The second request reused that peer session after
restart. Testing exposed repeated tool-summary rows for streamed updates; a
regression now keeps one evolving summary per tool call, including status-only
updates and interleaved calls across archive reopening. The second live request
completed with this change; reopening its encrypted archive confirmed two
completed tool summaries and the complete final response. Its final native
visual check passed after the Mac was unlocked. The actual window displayed
the second completed turn with two tool summaries. The same response remained
readable after Stop server. Light/dark switching, enlarged settings layout and
keyboard Quit also passed. The app also now reads existing enrollment through private local IPC:
the native Attention view shows the verified agent after restart instead of
onboarding. Reads never submit a receipt or add another central poller.

Local evidence is under `.build/desktop-design/`: `connections-ui-result.json`,
`live-app-result.json`, `live-app-repeat-result.json`, `live-app-archive-result.json`,
`live-app-registered.png`
and `live-app-first-conversation.png`, `live-app-final-conversation.png`,
`live-app-final-offline.png` and `embassys-zoom-settings.png`. These are qualification artifacts, not
application fixtures. Disposable test addresses and the synthetic phone number
were used; credentials and email decision tokens are excluded from evidence.

An enrolled background measurement exposed a redundant Dock-icon bitmap: the
one-instance packaged host exceeded its budget at 312 MiB. Using the packaged
icon directly reduced an unenrolled instance to 169 MiB and a verified instance
with an active central receiver to 167.5 MiB, across five app-owned processes.
The enrolled ten-second CPU sample was 0.10% of one core on an Apple M1 Max,
Darwin 25.6.0. No provider was executing during those samples. The macOS CI lane
now runs the existing 250 MiB / 1% background gate and retains its report.
Evidence: `icon-memory-before.log`, `icon-memory-after.log` and
`single-enrolled-resource-qualification.json` in the same local evidence directory.
This does not settle active-provider or other-platform resource budgets.

The latest complete repository check passes 402 tests with seven expected skips.
The lower total than the intermediate 405-test run reflects consolidation of the
old Claude-only tests, with additional shared-helper edge cases. Desktop
compilation and the bundled runtime/SQLite/MCP probe pass. Code commit `8a6c105`
passed the expanded desktop suite, package builds and actual host probes on
macOS, Windows and Linux in
[run 34139768294](https://github.com/embassys/ambassador/actions/runs/34139768294),
including the new macOS background resource gate. This does not qualify native
Windows/Linux controls or installed providers.

A development export of the live target's 283 diagnostic records retained request
and response bodies when selected. The metadata-only export omitted them. All
100 protected header occurrences were redacted, no compact token was present,
and the saved export was owner-only. This check used the same export service as
the native dialog; the dialog itself passed the earlier Mac check. Evidence is
`live-export-result.json` and the local `live-diagnostics-export.jsonl`.

The next component pass uses the OS accent, with tested text contrast in light
and dark themes and a fallback for missing or invalid accent values. macOS has
compact push buttons and a segmented theme selector; Windows and Linux have
their own control sizing. This refines the approved web UI, without adding a
toolkit. Rapid theme changes are serialized and retain the latest choice. The
complete repository check passes 403 tests with seven expected skips. The
bundled worker and packaged host probes pass; the background sample measured
165.8 MiB and 0.10% of one core with one unenrolled instance and no provider.
The packaged Mac check caught and fixed a lost theme choice during a fast
arrow-key change. Repeating Light → System → Light → Dark retained Dark and
keyboard focus; Tab moved to the next enabled control. Light/dark rendering,
enlarged text, and Start/Stop of the isolated enrolled server passed. Screenshots
are `native-controls-light.png`, `native-controls-dark.png` and
`native-controls-zoom.png` under `.build/desktop-design/`. These are actual Mac
window captures, not renderings of Windows/Linux controls.

Remaining desktop work:

The user approved the [2026-09-07 API review](desktop-api-review-2026-09-07.md)
proposal. [ADR 0065](adr/0065-desktop-development-registration.md) records the
first-time registration, read-only permission/status views and running-app
notifications implemented using existing APIs. The app saves each attempt before
submission, binds verification to the saved email and executor, and does not
repeat uncertain requests. Resend is explicit with a persisted cooldown. MCP
callers use the app's enrolled identity and are directed to the app while it is
unenrolled. The permission view distinguishes failed reads from empty lists;
local work is paged without consuming results or restarting a stopped server.
OS banners are opt-in, generic, coalesced and deduplicated across restart. They
include provider-tool approval requests after the email submission succeeds.
That first pass did not add app approval, returning-user login or remote push.
ADR 0068's later owner sign-in and account views are recorded below.

The 2026-09-07 regression run passes 420 tests with seven platform skips.
Desktop typechecking, package inspection and the actual packaged Mac host probe
pass. The final background probe measures 165.7 MiB and 0.10% of one core.
Using private IPC to the packaged server and a disposable email, live central
testing passes first-time registration, rejected/valid code handling, restart,
empty/pending/granted permission snapshots and a correlated notification event.
The grant did not create an action. The verification code and email decision
credential were absent from the diagnostic files. This is server/IPC evidence,
not native form or OS banner evidence. The Mac locked before those new UI checks;
native form entry, banner display/click and Windows/Linux notification behavior
remain unqualified. Local evidence is saved under
`.build/desktop-design/live-development-flows.json` and
`.build/desktop-design/development-final-check.log`.
Code `e800b84` passed the desktop tests, package builds and actual packaged-host
startup/shutdown probes on macOS, Windows and Linux in
[run 34147214481](https://github.com/embassys/ambassador/actions/runs/34147214481).
This does not qualify native forms, OS banner display or provider behavior on
those systems.

- Qualify the completed Codex and Hermes helpers beyond macOS arm64.
- Qualify the platform control refinements on native Windows/Linux desktops,
  including tray behavior and provider setup. A system-widget UI would need a
  separately approved toolkit prototype; none has been selected or installed.
- Qualify active-provider resource use and native Windows/Linux resource budgets.
- Complete owner decisions, recovery, revocation handling and native push as the
  remaining contracts in API issues 7–10 become available. Owner sign-in and
  read-only account views now use the deployed APIs. Issues 1–6 remain release risks.
- Complete trusted engine selection, signed installers/updates and installed
  launch-at-login qualification. These need trusted builds and signing inputs.

The current checks are not completion of the full matrix below.

## Delivery sequence

Build one complete request flow before expanding the screens. The first useful
vertical slice is: open app, sign in, connect an executor, receive a request,
review the exact permission, answer a question, see the result and reopen the
same conversation after restart.

An API fixture can unblock development, but cannot qualify the real sign-in,
owner approval or notification experience. Production release depends on the
server's recovery and owner authorization work as well as the desktop client.

### 0. Approve boundaries and settle contracts

Deliverables:

- ADRs for the desktop shell/dependencies, owner identity and trust, instance
  isolation, visible transcript retention and desktop distribution.
- Clickable screen prototype for onboarding, Attention, request detail,
  Conversations, Permissions, Agents and Diagnostics, including failure states.
- API issue updates for D1–D8 from the design. Extend issues 1–6 where appropriate;
  do not create duplicate recovery work. API code stays in `agent2agent`.
- A proposed supported OS/architecture matrix and a list of actual test machines.
  Start qualification with macOS Apple silicon/Intel, Windows x64, and Linux x64
  on selected GNOME and KDE distributions. Add Windows/Linux ARM64 only when
  installers, runtimes and selected providers pass native tests.

Exit: owner approves the design choices and retention policy; server contracts
have reviewable schemas and failure semantics. Exact dependency and installer
choices are recorded before installation or scaffold generation.

### 1. Prove packaging and lifecycle on all three systems

Create the smallest shell with a tray, window and supervised gateway. Package a
fixed Node runtime and the existing engine without requiring a terminal, Node
installation or launch-time package downloads. Run the installed build from
normal application launchers, not only from a developer shell.

Write failing tests first for the worker handshake, process lock, start/stop,
host death, intentional-stop persistence and instance selection. Include the
native SQLite module and a real bundled ACP adapter in the packaged prototype.
GUI launch environments must find reviewed providers without scraping login
shell configuration or exposing provider credentials.

Measure startup, idle CPU/memory, package size and renderer disposal while hidden.
Provisional targets, not measured claims: a useful window within 2 seconds warm
and 5 seconds cold, steady idle CPU below 1% on a reference machine, and total
app-owned idle memory below 250 MiB with the main window closed and no provider
running. Record the machine and separate provider resource usage. If the Electron
prototype exceeds the agreed budget, compare the Tauri sidecar prototype before
building the full UI. Confirm the budgets after measurement.

Exit: installed packages start, stop, quit and reopen on each target; no orphan
providers or duplicate receiver remain after crashes; framework choice is proven.

### 2. Extract shared services and isolate instances

Refactor the existing core behind typed interfaces. Keep CLI behavior and its
tests passing. Desktop controls call services directly rather than parsing CLI
output or impersonating an MCP client during registration.

Candidate boundaries, with file placement settled in the implementation ADR:

| Service | Responsibility and existing source |
| --- | --- |
| Gateway host | Lifecycle, runtime notices, storage ownership; `src/gateway-application.ts`, `src/cli.ts` |
| Enrollment | App-selected reviewed executor plus central identity; `src/central-enrollment.ts`, `src/guided-registration.ts` |
| Workflow queries/commands | Typed reads, existing owner continuations and explicit receipts; `src/message-box.ts`, encrypted stores |
| Session/history | Peer metadata, bounded provider reads and new visible transcript archive; `src/acp-session-store.ts`, `src/direct-delivery.ts` |
| Instance management | Canonical roots, lock/control binding, endpoint and runtime selection; `src/gateway-paths.ts`, `src/local-control.ts` |
| Desktop owner service | New owner session, inbox, decision/audit cache and cursor synchronization |
| Agent connectors | Reviewed detection, scoped configuration changes, connection verification and undo |
| Notification coordinator | Durable event observation, badge, OS notification and push deduplication |

Define versioned IPC commands and bounded responses before implementing them.
Mutations include persistent command IDs and account/instance identity. Reject
unsupported UI/engine combinations before opening state. Keep one writer per
instance and no direct renderer/owner-worker SQLite access to an active gateway.

Add named instances, port and location selection, labels and per-instance logs.
Update private control, Host/Origin checks, setup guidance and native bridge
bindings together. Do not add CLI flags unless their exact interface is approved.
Verify provider configuration isolation before enabling concurrent executors.

Exit: two versions run on different ports and roots; stop/clean/receipt/config
changes to one do not affect the other; existing workflow regressions still pass.

### 3. Sign-in, device binding and agent connections

Depends on central D1/D2 for the complete flow. Implement email/code screens,
returning-user recovery, owner-session custody and explicit agent/executor
selection. Account state must remain separate from provider login and runtime
health. Test a verified account with no grants and no executor installed.

Implement connection helpers first for Codex and Claude Code, then OpenClaw and
Hermes. Each needs independent fixture tests for every supported configuration
scope plus a native installed-client check. Preserve existing tools and settings.
Ask before a provider restart that interrupts active conversations. Show manual
guidance for missing providers and unsupported clients.

Create fresh Embassys instances. CLI import and migration were removed from
scope by the user on 2026-09-07. Never use Clean to manufacture a new central
identity; existing-account recovery still requires the owner API.

Exit: a new and a returning user can reach a working connected agent entirely
through the app; old grants survive supported recovery; ordinary prompts require
no website/tool hint or agent-side email verification.

### 4. Attention, decisions and running-app notifications

Depends on D3/D4/D5. Implement the owner snapshot/event contract, encrypted inbox
cache, review forms and native notifications on macOS, Windows and Linux.
Decisions share central's email transaction and invalidate stale alternatives.

Keep owner questions, resource permissions and provider-tool approvals separate.
Reuse local continuation processing for answers, retaining the original call,
question, message and provider invocation identifiers. Do not allow MCP to call
the owner decision interface.

Implement timeout, expired request, already answered elsewhere and unknown
submission states before the happy-path UI is considered complete. Reading or
dismissing an item does not consume an agent result or grant permission.

Exit: permission plus owner-input plus result round trip succeeds with a real
requester and executor; app/email/device races produce one authoritative outcome;
disconnect and restart recover pending work without resubmitting execution.

### 5. Conversations, permissions and diagnostics

Build paginated list/detail screens from the shared queries. Capture visible
ACP messages going forward, including stream normalization and replay deduplication.
Label old/partial/provider-unavailable history. Keep activity available even when
a provider cannot supply conversation history.

Add the Permissions views with D6, including source, scope, expiry/use limits and
revocation semantics. Add result layouts once D8 supplies schemas. Expose errors
and central connection state without a log dump on the home screen.

Implement log filters, reveal folder, support export preview, transcript deletion,
retention controls and Clean with unresolved-work disclosure. Test these against
large histories and exhausted quotas. ADR 0067 records the approved production
log policy; signed distribution still requires separate release authorization.

Exit: a user can trace an incoming request from permission to execution to exact
result, read the available conversation after restart, see what they approved,
and export a useful redacted diagnostic bundle without using a terminal.

### 6. Native remote push and offline recovery

Depends on D7 and completed cursor recovery. Implement APNs registration,
rotation, notification routing and signed macOS activation tests. Implement the
selected Windows push packaging/native integration and its activation handler.
Keep Linux's running-app delivery and email fallback explicit.

Test notification denial, Do Not Disturb, OS suppression, stale tokens, revoked
device, sign-out, sleep/wake, no network, expired request and a click after an
account switch. Deliver the same event through push and the feed and verify one
inbox item and bounded notification behavior. A push click must fetch current
state before allowing a decision.

Exit: qualify running, window-closed, explicitly-quit and machine-sleeping cases
separately for each platform. Document what the OS actually does; never infer
display or wake-up from provider acceptance alone.

### 7. Distribution, updates and release qualification

Add desktop packaging/publication only after approval. Sign all executable
components, notarize macOS builds, validate Windows identity and package behavior,
and test supported Linux packages on real desktops. Publish artifact manifests,
checksums and a software bill of materials. Keep the npm CLI release independent.

Test updates with active requests, unresolved provider approval, low disk,
interrupted download, invalid signature, interrupted schema upgrade and a failed
restart. Prevent unsupported downgrades from opening newer state. Test launch at
login, uninstall and reinstall without orphan services or accidental data loss.

Run accessibility, layout, performance, multi-instance and long-running tests on
installed signed artifacts. Finish with real cross-agent flows using ordinary
prompts and screenshots of the final app and agent conversations.

Exit: all app release gates and central dependencies pass; observed limitations
are documented; user approves the release. Fixture success is never sufficient.

## Regression matrix

Retain [the existing workflow cases](workflow-test-plan.md) and add the following
before implementing the corresponding boundary. Each production bug should get
a deterministic reproduction when feasible and a live retest for UI/provider
behavior. No finite suite guarantees every possible edge case.

| Boundary | Required failures and races |
| --- | --- |
| Owner authentication | Wrong/expired/reused code, resend race, throttling, no email, lost successful verification response, refresh race, revoked device, offline startup, same email returning after Clean |
| Authorization | Agent token rejected by owner APIs, wrong owner/device/agent, forged UI IPC/frame, stale account view, malicious request Markdown/URL, no credentials in renderer or exports |
| Onboarding | No provider, provider signed out, configured but unconnected MCP, executor differs from caller, zero grants, provider changed while a request is pending |
| Configuration | Invalid TOML/JSON/YAML, concurrent edits, duplicate entry, managed settings, missing permissions, spaces/unicode in paths, symlinks, Windows ACLs, WSL versus native scope, undo after user modification |
| Lifecycle | Double launch, existing CLI, unrelated occupied port, default-No stop, cancelled stop, engine/host/renderer death, intentional stop, sleep during approval, network flapping, absent tray |
| Instance isolation | Same port, same/aliased/nested roots, wrong control secret, stale process ID, stable/beta apps together, two runtime versions, shared provider config, wrong native bridge, Clean one while another works |
| Custody/events | Crash before/after local commit, lost ack, duplicate/out-of-order event, reconnect cursor gap, concurrent devices, owner feed cannot consume execution message, executor transfer fences old receiver |
| Decisions | App and email race, two windows/devices, exact provider options, expired/revoked/used grant, stale revision, lost response recovered by mutation ID, pending call changed, dead ACP invocation, offline draft never auto-approved |
| History/results | Replayed stream, partial turn, provider compaction/deletion, unavailable old history, webhook history absent, duplicate badges, one peer across restarts, two peers never merged, viewing does not consume agent result |
| Storage/clean | Quota full, disk full, malformed ciphertext, missing/locked secret store, unresolved work at Clean, logs preserved, local history delete versus provider delete, schema downgrade refused |
| Notifications | Feed/push duplicate, device token rotation, invalid token, DND, denial, no tray, click after sign-out/account switch, expired item, restart on click without automatic execution, no sensitive preview |
| Updates/export | Invalid update signature, mismatched engine/UI protocol, shutdown with active work, secret scan of installed artifacts and bundles, partial export, no automatic upload |
| UX/accessibility | Keyboard navigation, focus after update/dialog, screen reader, zoom/high contrast, dark mode, high DPI, long/unicode text, timezone/DST, unambiguous empty/offline/error states |

## Live acceptance scenarios

1. New owner installs from a signed package, signs in with email/code, connects
   an installed agent and asks naturally for another person's phone number.
   Capture the opening response, permission request, exact result and receipt.
2. Another person's agent needs owner input. With the app window closed, the
   owner gets a notification, opens the matching question, answers, and the
   original requester receives the result once.
3. Repeat a meeting request with a real busy interval from 2–4 PM, differing
   timezones, separate read/write access and a consenting test calendar recipient.
   Verify both the event and actual invitation delivery, then the denial path.
4. Interrupt connectivity immediately after a central submission and immediately
   after server message claim. Recover the same operation without a new action.
   Use fault injection in controlled qualification; do not disrupt unrelated users.
5. Answer through email while the app's request detail is open, then attempt the
   stale app choice. Show the existing decision and never dispatch twice.
6. Start two versions with different state roots and endpoints, each using a
   separately bound provider profile. Complete requests simultaneously, then stop
   and clean one. Prove the other identity, grants, tools and history remain intact.
7. Restart, upgrade, sleep and sign in again. Show pending work and available
   history with accurate completeness labels. Existing grants survive supported
   identity recovery; unread agent results remain available.

Record platform, app/core/provider versions, installer hashes, central revision,
configuration scope, timestamps, exact results, screenshots and cleanup. Keep
failed attempts and their fixes in the qualification record. Synthetic data and
consenting test identities prevent accidental real-world sharing or invitations.

## Work that can proceed before API delivery

The shell, shared service interfaces, instance isolation, connection helpers,
history capture, diagnostics and fixture-backed screens can be built while the
API issues progress. Existing agent enrollment can support a labelled development
demo for a fresh identity, but it is not the final owner login design.

D1/D2 block complete returning-user onboarding and recovery. D3 blocks app-native
resource decisions. D4/D5 block a reliable production workflow. D6 blocks complete
permission history/revocation. D7 blocks native remote push. D8 blocks full result
validation and remote progress. Preserve these gates even if the UI is finished.

## Local completion pass, 2026-09-07

[ADR 0066](adr/0066-desktop-completion.md) and the
[distribution guide](desktop-distribution.md) cover the work authorized without
server changes. Packaging now uses the frozen production lockfile and a hoisted
dependency tree. Qualification found and fixed absolute links back to the build
directory and adapter versions resolved outside the lockfile. The extracted Mac
DMG passes exact inventory, SQLite, adapter-resolution and real MCP worker tests.
The same archive/portability checks run in all three desktop CI jobs.

The app checks all bundled gateway source files and its app/core/Electron,
platform, architecture and private protocol before starting. Worker startup also
checks Node's version. Signing is explicit and fails on missing inputs or failed
verification. Mac login startup now uses actual signature, Gatekeeper and stapled
ticket verification; it stays unavailable on this unsigned build. No signing
identity or update channel is configured, and no artifacts were published.

The full local check passes 425 tests with seven platform skips, plus three
artifact-tool tests. The packaged Mac host starts and stops its server, preserves
it through a duplicate launch, and measures 167.6 MiB with 0.20% of one core while
idle. Live registration through the packaged worker again passes invalid/valid
code handling, restart, pending/granted permission reads, correlated notification
IPC and credential redaction. Native form/banner inspection remains unqualified
while computer control reports the Mac locked.

A repeated live Claude request exposed a model behavior gap: Claude asked for
confirmation only in its background transcript. The request remained pending.
The delivery cue now explicitly includes confirmation in `ask_owner`, and the
initial instructions distinguish a new call ID from a replay. The test driver
recorded that observed question and an answer for the same call; the original
five-minute test deadline then stopped the app before a result, so that run is
not end-to-end success. Prompt guidance is not a guarantee that every model will
use the tool; preserve this case in subsequent provider qualification.

A fresh-identity rerun then reached a central delivery limit. Central accepted
the synthetic action, but repeated polls on the new recipient exceeded the
40-second client deadline before any local action capture. The
[central follow-up record](central-follow-ups.md) keeps this observation with
issues 1 and 3. No speculative poll fallback or action replay was added. This
run is not live end-to-end qualification of the new package.

CI for code `f5b9be6` passed macOS and Linux. Windows passed archive extraction,
packaged Node/SQLite/MCP and actual host startup before its test cleanup hit a
transient lock on Chromium's Trust Tokens cache. Cleanup now retries only the
test's own directory for a bounded period after the server is confirmed stopped;
a persistent lock still fails. Native Windows Quit and notification behavior
remain outside this CI evidence.

Code `02e6aa8` then passed all three platform jobs in
[run 34154117576](https://github.com/embassys/ambassador/actions/runs/34154117576),
including the Windows cleanup retry, extracted archives, actual packaged host
startup/shutdown and the Mac background resource gate. All live test servers
were stopped afterward. The unsigned Mac DMG remains a local development
artifact under `.build/desktop/distribution/`; nothing was released.

Remaining work that needs no central change but does need external input:

- Signed installers, automatic updates and engine-version installation need
  release certificates, a distribution channel and compatible signed artifacts.
  Runtime checks alone do not qualify opening newer state with an older engine.
- Real Windows/Linux desktop and broader provider qualification need those
  environments. The Mac is available and the latest checks are recorded below. Calendar invitation
  delivery needs a configured calendar account and consenting test recipient.
- Hermes native return still lacks a qualified atomic idle-only injection and
  trusted-origin path. OpenClaw display and Codex first-chat discovery need the
  remaining native tests. Provider behavior is not central API behavior, but it
  cannot be marked qualified from a fixture or background log.

## Remaining owner and release inputs

The shell, architecture, development diagnostics and proposed visible-history
retention were approved on 2026-09-07. Remaining inputs are:

- Access through normal release infrastructure to Apple signing/APNs and Windows
  signing/push registration, plus a decision on distribution channels.
- A confirmed first-release OS/architecture matrix and real devices/providers
  for qualification. Do not interpret a Linux or Windows CI runner as a tested
  user desktop.

API changes remain issue-only here. The app plan does not authorize central code
changes, provider credential collection, app-store submissions or publication.


## Approved setup and retention completion

ADR 0067 records the owner's approval for the exact desktop-only parsers,
metadata-only production logs, seven-day retention and a 1 GiB cap per instance.
Development builds continue to retain credential-redacted bodies. The app has a
confirmed Clear logs control that preserves conversations and pending work.
The viewer reads backwards in bounded blocks and pages; export previews have a
separate, visible 32 MiB limit. Rotation, expiry, stale cursors, oversized records,
queued clears, stopped-instance locking and instance isolation have regression
coverage. Published CLI defaults remain unchanged.

Codex and Hermes setup now preserves unrelated settings and comments through
validated TOML/YAML edits. Existing ownership, review expiry, conflict detection,
repair and disconnect apply to both. Parser code is bundled only into the desktop
host. Tests cover missing/matching/conflicting entries, comments, edits during
review, invalid/duplicate data, unsupported inline TOML and YAML aliases/merges.

The native Mac test used two fresh app instances and disposable provider profiles.
Clear cancellation preserved records; confirmation removed only the selected
instance's logs while its server remained running. The second instance retained
132 records, displayed as 100 and 32 across two pages. Its pending-work marker
was unchanged. Codex and Hermes connection dialogs saved their entries, and
another instance could not overwrite the Codex profile. The installed Codex
reported the expected URL and a 660-second timeout; installed Hermes listed the
entry and connected to the packaged app, discovering all six MCP tools. No
personal provider profile or central identity was changed.

Evidence is in `.build/desktop-design/installed-setup-results.json` and the native
app observations in this task. These tests qualify the setup helpers, not another
live central action exchange. The earlier central polling failure remains open.
The [new web app review](desktop-web-app-review-2026-09-07.md) records owner APIs
that are now deployed and the remaining recovery, pagination and decision gaps.

## Owner account integration, 2026-09-07

ADR 0068 implements the approved next step using web app source `a9cb3d3` and
central source `a8c0e77`. Account sign-in, code verification, serialized session
refresh and sign-out run in a separate bundled Node worker. Its atomic encrypted
session file and process lock live outside the gateway instances. The app exposes
no owner credential through renderer IPC, agent tools, logs or provider settings.
One-use exchanges save an uncertainty marker before submission and are never
automatically repeated after a lost response or restart.

The Account screen shows pending requests, permissions in both directions and
central message history. These are bounded read-only snapshots, with visible
server limits and explicit refresh. Questions and options remain text; decisions
and answers continue through email or the ordinary web app. Reads do not consume
messages or results. Sign-out leaves local servers running. Selecting, stopping
or cleaning a local instance does not select or clear the owner account.

Regression checks pass 453 tests with seven expected skips. A further focused
regression proves that Clean preserves the shared owner session and another
instance's work; all 19 owner tests pass. Twelve desktop
artifact/parser/rendering tests pass, as do root and desktop typechecking.
New coverage includes code errors and cooldowns, account context changes,
concurrent refresh, missing responses, failed local saves, restart, token realms,
expired sessions, offline reads, malformed/oversized data, encoded JSON columns,
private IPC, linked files and log redaction. Rendered agent text is escaped;
unknown permission menus never become guessed decision buttons.

Controlled live tests through the packaged owner worker passed email login,
wrong/valid codes, profile, requests, both permission directions, message history,
restart and real refresh rotation. The test advanced only the local refresh
deadline to exercise rotation without waiting fifteen minutes. Three concurrent
reads caused one refresh submission. Sign-out invalidated the session at central
and remained signed out after restart. A valid agent DPoP request still returned
200; agent credentials on the owner route and owner credentials on the agent
route both returned 401. The missing explicit server guard for other malformed
app claims remains a separate contract follow-up, not a claimed client fix.

Native Mac tests used two disposable instances and the existing synthetic
Mailosaur identity. Email/code entry, rejected-code feedback, live permission and
message views, instance switching, keyboard Quit and app restart passed. Owner
sign-out cleared account views while the selected server kept running; explicit
Stop then stopped that server. Light/dark forms and segmented navigation were
inspected. Testing corrected stale onboarding copy, transient request feedback,
the resend countdown and visible extra radio circles. Both local work markers
survived. All test locks were released and the temporary account profiles were
removed after confirmed sign-out.

With the final Account sign-in screen open, the usual Personal instance stopped
and no providers active, macOS physical footprint settled at 154.3 MiB across
five processes. A ten-second sample measured no additional CPU time. This is an
idle visible-window measurement, not a signed-in workload or provider budget.
The extracted development DMG also passed its checksum, inventory and isolated
real MCP worker checks.

Local evidence is in `.build/desktop-design/owner-live-qualification.json`,
`owner-realm-qualification.json`, `owner-native-qualification.json`,
`.build/owner-final-check.log` and `.build/owner-ui-tests.log`.
The visible-window resource sample is in
`.build/desktop-design/owner-visible-resources.json`.
Runtime code `f3b5cfd` passes all three desktop CI jobs in
[run 34164481469](https://github.com/embassys/ambassador/actions/runs/34164481469):
macOS, Windows and Linux regression checks, packaging, extracted distribution,
and actual host startup/shutdown. The Windows suite exercises the real file
access-control helper for owner session transitions.
Actual packaged host lifecycle and isolated-runtime checks also passed. This does
not qualify native Windows/Linux account UI, in-app decisions, full owner history,
recovery of agent credentials, a durable owner event feed or native remote push.
No server code changed and no release was published.


Earlier code `31531b2` passes 435 regression tests with seven expected
platform/qualification skips, plus all nine desktop parser/artifact tests.
Root and desktop type checks pass. Lint reports only the two pre-existing
optional-chain suggestions in visible-transcripts.ts. One parallel verification
process was terminated with signal 9; the sequential full rerun passed.

All three desktop CI jobs passed on macOS, Windows and Linux in
[run 34160941381](https://github.com/embassys/ambassador/actions/runs/34160941381).
This includes the parser tests, packaged worker, portable copy, extracted
archive and actual host lifecycle. It does not qualify real Windows/Linux
provider interactions or user-visible notifications.

The final local Mac background host measured 171.0 MiB across five processes and
0.10% of one core while idle. Its extracted DMG passed checksum, inventory and
real MCP worker verification. Local artifact:
`.build/desktop/distribution/Embassys-0.1.0-darwin-arm64-development.dmg`.
SHA-256: `41801f9ec5f56b1bf2c0179406aa7c8a51cb8d75113cf3cf913b72799e7a53f7`.
Nothing was published. Both disposable test instances and their provider profiles
were removed after confirming they were stopped. The usual Personal app profile
was reopened with its server still stopped and its existing logs preserved.

## Shared installation and simpler navigation, 2026-09-07

ADR 0069 implements the owner's later request for CLI/app handoffs. Fresh desktop
setup uses the default CLI installation. Existing isolated instances stay in place;
Device settings can add the shared installation. The app and matching CLI build
share registration progress, identity, pending work, visible history and the
saved executor directory. Switching hosts does not register again or copy credentials.
The app includes a copyable start command for its bundled CLI; older installed
versions are not qualified to read newer development state.

Start, Stop and Clean authenticate any running owner before asking to stop it.
Cancellation preserves that process. The private stop command cannot be sent by
the renderer. A stale process ID cannot stop a replacement. When the app hands
off, it saves the stopped preference and stops its recovery loop, so reopening
it does not interrupt a running CLI. The existing exclusive Clean review still
protects identity and unfinished work.

The UI now follows the web app's Requests, Permissions, Messages and Account
navigation, ink/teal palette and simpler layout. Account snapshots and local agent
activity have separate labelled views. Device setup, server preferences and logs
sit under Account. Native window controls, system fonts, appearance preferences,
keyboard access and high-contrast styling remain. No toolkit or dependency was added.

Current local checks pass 465 tests with seven expected skips, plus 14 desktop
rendering/parser/artifact tests. The encrypted fixture test verifies registration
and pending work across CLI → app → CLI, with one registration and one verification.
The actual packaged process test also passes on this Mac: public CLI startup,
fresh app attachment, authenticated handoff, persisted stopped preference and
app restart while the CLI continues running. The final packaged runtime,
shared-host probe, actual host lifecycle and extracted DMG checks all pass after
the revocation-reader and native UI corrections.

The live revocation test exposed a permission-list parser that rejected revoked
records. It now accepts the five statuses in the reviewed server contract and
classifies the exact revoked-action refusal. Local tests cover stale grants,
revocation before dispatch, uncertain submissions and explicit new requests.
The live repeat passed after one delayed email required the supported resend
flow. Central's actual revocation message reached the gateway, triggered a
permission notification and appeared as revoked in the permission list. No
action or automatic permission request was created. The temporary owner session
was signed out and local test state removed. Evidence is in
`.build/desktop-design/revocation-live-qualification.json` and the packaged
handoff checks in `.build/desktop/shared-host-qualification.json`.
Native Mac checks now pass for the four-section layout, labelled account/local
views, light/dark appearance, foreground handoff cancellation and confirmation,
server controls and Clean. Cancel left the CLI running; confirmation shut it
down cleanly and started the app. Clean removed only a disposable local marker,
preserved logs, and allowed the matching public CLI to start afterward. Native
inspection moved Start/Stop above the other preferences and collapsed connection
and storage details. Both temporary processes stopped before their test profile
was removed. The original Personal app profile is open again, still stopped,
with its three pre-existing log records intact. Evidence is in
`.build/desktop-design/native-shared-qualification.json`.
No server code changed or release was published.

Runtime `2a35086` passes all three desktop CI jobs in
[run 34167476745](https://github.com/embassys/ambassador/actions/runs/34167476745).
macOS, Windows and Linux passed regression tests, packaging, extracted distribution,
actual host startup/shutdown and the public CLI → app → CLI handoff. This does not
qualify native Windows/Linux UI, provider-specific native return or remote push.

## Remaining-work review, 2026-09-08

The user asked to complete remaining work except platform testing. Reviewed the
current central revision `a8c0e77` and web app revision `a9cb3d3` again. Owner
email login, account reads and permission revocation are already integrated.
The remaining recovery, decision-context, history and native-push contracts are
still absent. Updated existing API issues 7–10 with the deployed behavior and
the specific missing fields or guarantees. No central or web app code changed.

ADR 0070 fixes OpenClaw native return observing port 8787 regardless of the
selected instance. The observer now follows the reviewed local MCP entry and
keeps a separate journal for each endpoint. Missing, disabled or incompatible
configuration disables return instead of selecting another instance. Optional,
fixed OpenClaw prompt guidance addresses Embassys discovery and unnecessary
detached wait tasks without changing user prompts or reading their history.
The provider's existing hook permissions remain under owner control.

Local verification on bundled Node 24.19.0 passed 472 tests with seven expected
skips, plus 14 desktop rendering/parser/artifact tests. Lint, typechecking and
the desktop build pass. Real OpenClaw foreground and delayed-return checks used
port 9797 while an independent gateway stayed on 8787. The final native view
showed the delayed synthetic result. Its hidden waiting reply and earlier
duplicate badge remain provider display defects, so return is still experimental.
See the [qualification record](qualification.md#openclaw-instance-and-discovery-retest-2026-09-08)
for prompts, fixture limits and screenshot paths.

Work still requiring external input or provider capability is recorded in the
current work plan. No signing identity is installed on this Mac and no repository
release secrets are configured. Signing, updates and engine installation need
the distribution inputs above; there are no signed compatible artifacts to
select yet. Calendar invitation testing needs the owner's chosen account and
consenting recipient. Codex computer control is unavailable, standalone Claude
Chat/Cowork has no configured Ambassador connector, and the installed Hermes
API still lacks the required trusted origin and idle-only injection behavior.
Native Windows/Linux qualification remains excluded from this request.

## Executor checks and Mac sidebar, 2026-09-08

ADR 0071 closes a desktop dispatch gap. The worker asks its host to verify the
selected provider's public Ambassador connection before recording dispatch.
Wrong ports, disabled or unsupported settings and unqualified project overrides
pause delivery while the message remains pending. The app shows the reason and
repair instructions. Receipt and processing continue independently. Tests prove
repair plus restart delivers the original message once and does not replay an
uncertain actual handoff. Host checks use the existing private process channel,
bounded readers and desktop parsers. No provider configuration or credential is
copied; live qualification of independent provider profiles remains open.

The Mac window now exposes native sidebar vibrancy through clear window and
sidebar backgrounds, with opaque content and an opaque Reduce Transparency
fallback. The packaged Mac app passed native light/dark switching, account and
device-setup navigation, and server stop/start. The user-facing setup guidance
now names Account > Set up this device. No new toolkit or dependency was added.

The real Claude Mac app completed fresh registration, code verification and a
phone request without a website question or tool hint. Four inspected screenshots
record the full conversation. Central and the contact were scripted fixtures;
this is not a deployed-central or two-real-agent qualification. See
[the Claude record](qualification.md#claude-mac-onboarding-screenshots-2026-09-08).

Current checks pass 480 core tests with seven expected skips and 16 desktop
tests, plus lint, typechecking and packaging. The packaged host passed startup,
duplicate launch and CLI → app → CLI handoff. Mac screenshots and the illustrated
walkthrough remain local in `.build/claude-onboarding/`. The preceding commit
`0729712` passed all three desktop CI platforms in
[run 34195202482](https://github.com/embassys/ambassador/actions/runs/34195202482).
That run does not qualify these subsequent changes. No API code changed or
release was published.
