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
visual check is pending because the
Mac locked. The app also now reads existing enrollment through private local IPC:
the native Attention view shows the verified agent after restart instead of
onboarding. Reads never submit a receipt or add another central poller.

Local evidence is under `.build/desktop-design/`: `connections-ui-result.json`,
`live-app-result.json`, `live-app-repeat-result.json`, `live-app-archive-result.json`,
`live-app-registered.png`
and `live-app-first-conversation.png`. These are qualification artifacts, not
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
compilation and the bundled runtime/SQLite/MCP probe pass. New branch CI results
will be recorded after this candidate is pushed.

Remaining desktop work:

- Complete Codex and Hermes configuration helpers after the requested parser
  dependency decision; qualify each helper on its supported native systems.
- Finish the unlocked Mac visual pass, keyboard/zoom checks and final screenshots.
  Qualify native Windows/Linux appearance, tray behavior and provider setup.
- Qualify active-provider resource use and native Windows/Linux resource budgets.
- Integrate owner sign-in, decisions, permissions and push when API issues 7–10
  provide the accepted contracts. Recovery issues 1–6 remain release risks.
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
large histories and exhausted quotas. Decide production log retention before
enabling production distribution.

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

## Remaining owner and release inputs

The shell, architecture, development diagnostics and proposed visible-history
retention were approved on 2026-09-07. Remaining inputs are:

- A production diagnostic retention policy.
- Access through normal release infrastructure to Apple signing/APNs and Windows
  signing/push registration, plus a decision on distribution channels.
- A confirmed first-release OS/architecture matrix and real devices/providers
  for qualification. Do not interpret a Linux or Windows CI runner as a tested
  user desktop.

API changes remain issue-only here. The app plan does not authorize central code
changes, provider credential collection, app-store submissions or publication.
