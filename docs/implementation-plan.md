# Current work

The 0.2.19 development release is complete. [PR 39](https://github.com/embassys/ambassador/pull/39)
is merged; publication and artifact verification are recorded in the
[release notes](https://github.com/embassys/ambassador/releases/tag/v0.2.19).
The user approved [ADR 0061](adr/0061-durable-workflows-and-client-delivery.md),
implementation, regression coverage and live end-to-end testing, then authorized
the release on 2026-09-05 with the remaining limitations below.

## Open follow-ups

Captured together at the user's request on 2026-09-07. API work remains
issue-only. These items do not authorize another release.

- [ ] Central API recovery. Prevent message loss on disconnect, recover accepted
  submissions whose responses were lost, fix stuck polling, and support
  credential and identity recovery after expiry or `clean`. This is the biggest
  remaining reliability risk. Track server work in issues
  [1](https://github.com/embassys/agent2agent/issues/1),
  [2](https://github.com/embassys/agent2agent/issues/2),
  [3](https://github.com/embassys/agent2agent/issues/3) and
  [4](https://github.com/embassys/agent2agent/issues/4). Local durability cannot
  recover a message that central consumed before a lost HTTP response.
- [x] Codex discovery. A fresh desktop task on September 8 answered "Am I
  registered with Embassys?" through `get_my_permissions` without a website
  question or tool hint. This test used the deployed central service and the
  account registered in the native app. Task transcript evidence is available;
  Codex computer-control screenshots remain unavailable. Earlier registration,
  action/result and receipt evidence still applies.
- [ ] OpenClaw native display. Resolve the duplicate badge and hidden waiting
  reply seen on idle return. Saved history contains one native answer, and the
  result remains unread and recoverable. Keep native return experimental and
  foreground waits the default until the desktop behavior passes a retest.
  The September 8 retest reproduced both defects with one injected answer in
  saved history. A separate registration attempt also showed the duplicate badge
  before any Ambassador return. ADR 0070 fixes the bridge's hardcoded port and
  adds optional fixed discovery/continuation guidance; provider rendering remains open.
  With that guidance, a fresh conversation recognized the existing enrollment
  and a five-second wait received its later answer without a detached polling
  task. A completely unenrolled fixture also reached registration without a
  tool hint, but the host refused verification codes in chat. The new guidance
  directs the owner to Account > Set up this device in that case. The final review
  found the waiting reply inside the collapsed "Worked for…" section. Expanding
  it and resizing a blank Mac window are verified display workarounds. The
  renderer also has a reproducible accumulating duplicate counter; its correction
  remains upstream work. See the [desktop PR review](desktop-pr-review-2026-09-08.md)
  and the
  [September 8 qualification](qualification.md#openclaw-instance-and-discovery-retest-2026-09-08).
- [x] Calendar invitation delivery. On September 8 the owner authorized the
  connected Google Calendar for one disposable invitation. Native Claude Chat
  sent it to the test inbox; the delivered calendar attachment matched the
  attendee, title and September 9, 10:00–10:15 Europe/London time. Claude then
  deleted it, and the same inbox received cancellation for the same event UID.
  This qualifies the calendar connector's invitation path, separately from the
  earlier Embassys scheduling coordination tests. See the
  [desktop PR review](desktop-pr-review-2026-09-08.md).
- [ ] API result contracts and progress. Define and validate action-specific
  results, and tell callers when the other agent needs owner input. Track remote
  progress in [issue 5](https://github.com/embassys/agent2agent/issues/5) and result
  schemas in [issue 6](https://github.com/embassys/agent2agent/issues/6). Update
  Ambassador's validation, fixtures and qualification when those contracts exist.
- [ ] Broader client qualification. Qualify Hermes native return and each
  supported real-agent mode on Windows. Hermes
  native return first needs trusted origin routing and busy-session semantics.
  Windows CI passing does not qualify every provider; Claude Code desktop and
  Remote Control evidence does not qualify standalone Claude Chat or Cowork.
  The September 8 source review confirmed Hermes injection can interrupt active
  work, while its API wake path has no per-session lock. ADR 0074 now implements
  the separate local client for standalone Claude Chat and Cowork. Both native
  surfaces pass natural phone-number requests, actual OpenClaw results and explicit
  receipts. Fresh Cowork discovery of Embassys remains intermittent. Standalone
  hosts may end observation before ten minutes. The owner explicitly retained the
  600-second default under ADR 0075; pre-dispatch guidance explains later checks
  of the same request. The gateway never shortens or resubmits it.
  Manual development setup is documented; connector packaging and automated
  installation remain excluded distribution work. See the current
  [client completion record](client-completion-2026-09-08.md).
- [ ] Multiple engine versions and provider isolation. Embassys now supports
  named instances with separate ports, locations, credentials, locks, workflow
  state and logs under ADR 0064. ADR 0071 now checks the desktop executor's
  configured MCP binding before dispatch. Failed checks pause delivery with the
  message still pending; fixing the connection and restarting can resume it.
  Unsupported project overrides are refused. This does not pin cached provider
  connections or provision independent profiles. Finish trusted engine-version
  selection and qualify simultaneous provider profiles. Qualify MCP setup and native return against
  the selected instance, including concurrent providers and independent stop/clean.
  The published CLI remains fixed to its original port and state location; no
  new CLI selectors or migration are planned. ADR 0069 adds a shared installation
  and confirmed CLI/app handoffs using matching builds, not multiple engine versions.
  ADR 0070 now scopes OpenClaw return routes to its configured local endpoint.
  Two-server regressions and a real OpenClaw conversation on port 9797 pass;
  a separate gateway on 8787 remains untouched.
  September 8 deployed-central tests now pass both directions with real Claude
  ACP on 8787 and real OpenClaw ACP on 9797. Independent stop/clean of OpenClaw
  preserved the running Claude identity. This qualifies these two existing
  provider configurations, not two independent profiles of the same provider.
  ADR 0066 adds locked portable packages, source/host compatibility checks and
  runtime-version validation. A signed engine catalog, compatible state bounds
  and separately qualified artifacts are still required before enabling version
  installation or selection.

- [ ] Complete desktop production prerequisites. The local app, owner sign-in,
  read-only account views, setup helpers, logs, shared CLI installation and native
  Mac controls are implemented. Owner-authenticated approval, answer and revocation
  endpoints already exist and the web app uses them. ADR 0075 now implements
  desktop review, approval, exact button/text answers and
  revocation with durable no-replay markers. Full server-side mutation recovery
  and complete request context remain separate follow-ups. Complete history, agent
  identity recovery and native
  remote push still need central contracts. Signed distribution,
  trusted engine selection and native Windows/Linux/provider qualification need
  the release infrastructure and environments described in the
  [desktop plan](desktop-app-plan.md). API gaps remain in issues 7–10.

The owner excluded central API changes and distribution from the current work
on September 8. Native Windows/Linux qualification remains deferred. The combined
native signup, real Claude request, real OpenClaw owner-input continuation and
visible result/receipt now pass. ADR 0073 fixes valid existing connections being
rejected during setup. An open local Conversations view now refreshes its session
list without changing the selected transcript or page. Bounded reads never
overlap and late replies from a closed view are discarded.

The current candidate also implements ADR 0069: the web app's four-section
navigation and teal/ink visual language, a shared CLI installation, saved
registration across hosts, confirmed authenticated process handoff and stopped
state after handoff. Existing isolated instances remain separate. Current local
checks pass 503 tests with seven expected skips, plus 19 desktop rendering,
parser and artifact tests. Final native and live evidence belongs in the desktop
plan; these counts alone do not qualify a user-visible result.

ADR 0072 adds account-first onboarding. Signed-out users see Log in and Register;
email verification precedes executor choice. After login, one guided connection
screen leads into the main app. Setup can be explicitly deferred for account-only
access. Registration and owner login still require separate codes under the
current API; that gap is recorded in issue 7. Unfinished executor setup survives
restart without polling or dispatch. Completion is an account/instance-scoped UI
preference, never an authorization or proof of provider availability.
The native Mac app passed fresh registration and owner login against deployed
central, guarded Claude Code connection in an isolated profile, restart,
returning login, sign-out and existing-email recovery into login. See the
[onboarding qualification](qualification.md#embassys-account-first-onboarding-2026-09-08)
for evidence and the remaining two-code limitation.

See [central follow-ups](central-follow-ups.md) for server details and
[client delivery](client-delivery.md) for the current support matrix.

ADR 0075 adds native owner approvals, exact button/text answers and revocation
through the deployed web app API. Native Mac and correlated central outcomes pass;
see [owner decision qualification](owner-decisions-qualification-2026-09-08.md).
It also restores ten-minute standalone waits and fixes stdio startup through
filesystem aliases. Server recovery and fuller request context remain open.

## Implementation and qualification evidence

Implemented:

- Independent encrypted notification custody, processing, provider delivery and
  acknowledgement workers, with one shared owner/ACP answer receiver.
- Six-tool MCP catalog with typed message_box, exact catalog/schema validation,
  owner questions and answers, explicit receipts and durable repeated checks.
- Streamable HTTP streaming and the installed SDK's current stateless protocol
  path, separate wait capacity, cancellation and restart recovery.
- Rotating development request/response logs with credential redaction and
  preservation through clean.
- Opt-in OpenClaw return extension and experimental Claude Code channel proxy.
  Hermes uses foreground waits until its public APIs support a trusted gateway
  destination and injection without unwanted interruption.
- Explicit public enrollment context in MCP initialization, catalog and current
  permissions responses. An empty grant list no longer implies missing
  registration. Resumed identities and expired credentials retain that context.
- Short delivery prompts with message-specific cues and complete payloads.
  Shared workflow guidance loads through MCP initialization. JSON is indented
  inside a code block; OpenClaw direct prompts omit the directory banner.
  A real-provider restart check confirms reuse of the incoming requester
  conversation, with separate conversations for different requesters.
- OpenClaw webhook delivery uses enrollment-scoped persistent requester keys.
  Real hooks reused the same provider history after recreating the delivery
  target, and separated a different requester. Temporary hook settings were
  restored. See ADR 0063 and the recorded qualification.

The real 600-second SDK/HTTP wait passed at 600.011 seconds using a controlled
central fixture, followed by a check that continued the same action without
resubmission. Deterministic regression cases cover owner continuation,
duplicate replies, partial operation bindings, ambiguous delivery, receipt,
cancellation and provider failure. See [workflow tests](workflow-test-plan.md).

Current local checks pass: 346 tests and the production build. Seven default-suite
skips are four Windows access-control cases and three separately invoked
qualification cases. The ten-minute test and both clean-installed package lanes
have run explicitly. Commit `a59a20c`, including the native observer correction,
passed all Linux, macOS, Windows and Docker CI gates on Node 24.19.0, including
native Windows file-permission checks, package installation and audits.

Testing exposed and fixed JWK leakage into diagnostic bodies, a transient
atomic profile-write race, cancellation rejection handling during ACP startup,
interrupted prepared-action continuation, and stale pending inbox entries after
a reply had already completed. OpenClaw qualification also found separate
service/tool activation instances, native hook naming differences and stale MCP
connections after Ambassador restarted; all have regression coverage.

A subsequent real Claude desktop-to-OpenClaw test found and fixed the missing
foreground owner-answer continuation. Answers now enqueue durable local work,
recover interrupted handoffs, preserve the active question and use the original
central notification for any later provider approval. The repeated desktop run
displayed the exact result and acknowledged it after OpenClaw resumed from the
owner answer. It used a controlled central fixture. See the screenshot evidence
in [qualification](qualification.md).

The final runtime candidate passed the deployed REST action flow with real
Claude, Codex, Hermes and OpenClaw ACP targets. Each passed exact result and
receipt, running session reads, artifact scanning and cleanup. Claude also
passed two provider approvals. Codex and Claude passed provider history
deletion; Hermes and OpenClaw explicitly report it unsupported. All temporary
provider MCP entries and the OpenClaw extension settings were restored.

The user-operated Codex retest completed registration, one accepted phone action,
exact result and receipt after fixing UUID normalization and pre-submission
errors. Its opening website question prompted the subsequent fresh September 8
desktop task, which recognized Embassys without a hint. Discovery guidance fits
within the first 512 initialization characters.
The successful request supplied the same neutral purpose in the action payload
and permission reason. Exact catalog names and schemas remain authoritative.

Claude desktop Code completed a full 600-second wait, ended its turn on timeout,
and displayed the late result from real OpenClaw after the ordinary follow-up
"Any news?". The experimental Claude Code CLI channel also delivered a delayed
result without follow-up, visible through Remote Control. Neither observation
qualifies standalone Claude Chat or Cowork. ADR 0074 and the separate September 8
native tests now cover those clients' local transport and shorter waits; Hermes
native return remains deferred. The current matrix states these limits.

Meeting tests now cover enrollment with no grants, actual Mac Calendar busy
intervals, a local booking, and later availability/attendee/denial corrections.
A fresh explicit-time request checked availability first, included the verified
requester and accurately explained the target owner's denial. The target used
owner-provided availability in that final test. Actual invitation delivery still
requires a configured calendar account and consenting test recipient. No provider
account or personal Contacts card was changed to bypass that limitation.

Current real webhook qualification passes for both OpenClaw and Hermes.
OpenClaw reuses a requester history across target recreation; Hermes completes
the owner-question/result flow but its receiver creates a new session for each
webhook delivery. Hermes direct mode provides Ambassador-managed peer sessions.

The approved release procedure requires the versioned artifact, PR and
main-branch CI to pass before OIDC publication, followed by independent registry
verification. [PR 39](https://github.com/embassys/ambassador/pull/39) contains the
release change. Final publication status and artifact verification are recorded
in the [0.2.19 release](https://github.com/embassys/ambassador/releases/tag/v0.2.19).
The owner approved detailed development request/response retention with
credential redaction in ADR 0059 and release with the limits above in ADR 0015.

API follow-ups are [1](https://github.com/embassys/agent2agent/issues/1),
[2](https://github.com/embassys/agent2agent/issues/2),
[3](https://github.com/embassys/agent2agent/issues/3),
[4](https://github.com/embassys/agent2agent/issues/4) for uncertain submissions,
[5](https://github.com/embassys/agent2agent/issues/5) for correlated remote
waiting-for-owner progress, and
[6](https://github.com/embassys/agent2agent/issues/6) for action result schemas.
No API code changed.

## Earlier implementation and release evidence

The records below describe earlier candidates and the published 0.2.18 baseline.
They do not qualify ADR 0061's new workflow or original-conversation return.

ADR 0058's confirmed process stop is implemented. `start` and `clean` ask in an
interactive terminal before stopping the authenticated instance, then acquire
its released lock before proceeding. The full local check passed 274 tests
with six expected skips. Separate terminal processes also passed confirmed
start replacement and cleanup. Refusal, cancellation, a changed instance, and
shutdown timeout have deterministic coverage. These changes are unpublished.

ADR 0057's Ambassador changes are implemented: shared delivery intent
instructions, MCP session reclamation, exact provider approval choices, local
access after credential expiry, bounded ACP close, recoverable confirmed
outbound rejection, and bounded verbose response reads. Regression tests, the
full local check, a clean-installed package test, and controlled live REST
qualification passed. The live run used a mock ACP agent and a controlled
webhook receiver; the real-provider matrix has not been repeated for these
changes. See [Delivery qualification](qualification.md) for candidate evidence.

The user requested API issues instead of server code changes. Message custody
and batch bounds are in [API issue 1](https://github.com/embassys/agent2agent/issues/1),
credential renewal in [API issue 2](https://github.com/embassys/agent2agent/issues/2),
and listener lifecycle in [API issue 3](https://github.com/embassys/agent2agent/issues/3).
These remain production limitations. No API code was changed, and the
Ambassador changes have not been published.

ADR 0056 is implemented and qualified. Indexed encrypted stores allow 1 GiB
each, `get_inbox` pages safely, receipt capture covers approval polling, and
saved outbound intent dispatches the exact requested payload after a grant.
ACP sessions reuse context per remote identity while tracking each message and
action independently. Idle cleanup runs in bounded background batches. Existing
state and migration are outside the approved scope.

The deterministic suite, clean-installed live REST flow, real two-turn context
recall with all four providers, and combined real Codex-to-Claude action round
trip passed. The combined run also verified peer-session reuse and running
session reads on both gateways. OpenClaw uses its reviewed load path to restore
its gateway mapping. See [Delivery qualification](qualification.md)
for versions, artifact digests, and the limits of these checks.

PR 37 merged and version 0.2.18 was published on 2026-09-05. All six provider
delivery modes and every main-branch release gate passed, including Windows.
The independently downloaded npm artifact matched the qualified candidate and
passed clean-install, runtime, artifact, vulnerability, and signature checks.
The user deferred further Windows fixes to a separate pull request; no further
Windows change or release-gate exception was needed after the merge.
ADR 0057 replaces the deferred approval mapping with exact provider choices;
central recovery remains server work.

Phase 3B is complete. ADR 0050's common ACP policy, public Codex and Claude
adapters, persistent session lifecycle, session commands, verbose diagnostics,
provider-configured MCP use, retention cleanup, documentation, and deterministic
coverage are implemented. A clean packed Codex-to-Claude live run also passed
the deployed email-decision permission flow, all public CLI commands, and the
correlated action-result round trip. Evidence is in
[Delivery qualification](qualification.md).

ADR 0051's encrypted received-action-result storage is implemented. ADR 0052
replaces the three separate inbox views with `get_inbox`, which combines
unanswered action calls, unread action results, and ADR 0056's outbound status.
ADR 0054 replaces agent-side
Embassys permission decisions with the deployed human email flow and updates
the current request schema and live qualification. Verbose ACP logging reports
the available-command count without printing the command catalog or its
descriptions.

ADR 0055's implementation replaces automatic ACP tool approval with
`get_human_input`. The deterministic gateway test proves that the ACP request
remains pending, the local agent's own owner receives the question, the answer
is received as a correlated `human_input_response`, unrelated messages are
preserved, the control response is not prompted to the provider, and all
messages are acknowledged in order.

ADR 0053's live session inspection is implemented. `sessions list` and
`sessions show` use the foreground process while it runs; destructive session
commands remain stopped-only.

The controlled live Codex-to-Claude qualification of ADR 0055 passed against
the deployed own-human input endpoint. Version 0.2.18 is published under the
npm `latest` tag.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.

## Earlier desktop implementation evidence

The Embassys desktop app is approved under ADR 0064. The
  [design](desktop-app-design.md) covers the menu/tray app, owner email sign-in,
  agent setup, conversations, approvals, notifications, isolated instances and
  central API requirements. The [plan](desktop-app-plan.md) defines delivery
  phases, dependencies and regression/live release gates. The user approved
  the recommendations and implementation on 2026-09-07. The first shell, bundled
  worker, isolated instances and basic query views are implemented on
  `codex/desktop-app`. Packaged host probes passed on macOS, Windows and Linux. Native Mac
  instance/log-export/Clean-review checks passed. Searchable diagnostics, exclusive
  Clean previews, encrypted visible-history capture, bounded background workers
  and launch-at-login controls are implemented. The unsigned Mac build leaves
  login startup unavailable. The app is named Embassys; CLI import and migration
  are outside scope. Native archive display, custom storage selection and guarded
  Claude Code setup passed with isolated test data. Native testing also caught
  and fixed a hidden process after keyboard Quit and a reused port suggestion.
  The new candidate adds platform-specific appearance, the supplied branding,
  light/dark/system preferences and guarded OpenClaw setup. Both provider helpers
  support checking, repair and disconnect of app-owned entries. The full check
  passes 403 tests with seven expected skips. Two requests through the packaged
  app, deployed central API and real Claude executor passed exact synthetic result
  and receipt; the first completed turn was seen in the native app and survived
  restart. Live tests found and fixed repeated tool-summary rows and an enrolled
  identity still showing onboarding. Native inspection of the second turn passed after unlock,
  including stopped-server history, light/dark appearance, enlarged layout and
  keyboard Quit. A redundant Dock-icon allocation was fixed; the
  verified background instance now measures 167.5 MiB and 0.10% of one core.
  Code `8a6c105` passed package builds and actual host probes on macOS, Windows
  and Linux in [run 34139768294](https://github.com/embassys/ambassador/actions/runs/34139768294),
  including the macOS background resource gate. A live diagnostic export also
  passed body-inclusion and credential-redaction checks.
  Controls now use the OS accent with contrast checks, compact macOS buttons
  and a segmented theme selector, plus Windows/Linux control sizing. The UI
  remains web-rendered in the approved Electron host; no new toolkit was added.
  ADR 0065 adds first-time registration in the app, read-only agent permissions,
  paged local work and opt-in OS notifications for locally observed events.
  App-owned instances direct unenrolled MCP callers to Registration. Human
  decisions remain in email; returning-owner login, recovery and remote push
  still require central work.
  Its packaged server passes live first-time registration, code rejection and
  verification, restart, permission status changes and notification-event IPC.
  Native registration form and OS banner checks await an unlocked Mac; event
  delivery alone does not qualify visible notification display. Latest regression
  checks pass 420 tests with seven expected platform skips.
  Code `e800b84` also passes desktop tests, package builds and actual host probes
  on macOS, Windows and Linux in
  [run 34147214481](https://github.com/embassys/ambassador/actions/runs/34147214481).
  Codex/Hermes helpers passed isolated native Mac setup and installed-provider
  checks under ADR 0067. Its 1 GiB/seven-day logs and Clear logs control are
  implemented. Code `31531b2` passes 435 regression tests, nine parser/artifact
  tests and all three desktop CI jobs in
  [run 34160941381](https://github.com/embassys/ambassador/actions/runs/34160941381). Native
  Windows/Linux qualification, signed distribution and trusted engine selection
  remain open. ADR 0068 now implements owner email sign-in, session renewal and
  sign-out, plus bounded read-only account requests, permissions and central
  messages through the APIs identified in the
  [web app review](desktop-web-app-review-2026-09-07.md). The separate owner worker
  keeps tokens in encrypted custody outside gateway instances. Controlled live
  login, reads, restart, refresh and sign-out passed, as did native Mac account
  form and view checks. Owner runtime code `f3b5cfd` passes all three desktop CI
  jobs in [run 34164481469](https://github.com/embassys/ambassador/actions/runs/34164481469).
  In-app decisions, full owner history, identity recovery,
  and native remote push remain open. Explicit revocation-event handling is
  implemented in the current ADR 0069 candidate. See the
  desktop plan for evidence and the remaining matrix; API gaps stay in issues 7–10.
