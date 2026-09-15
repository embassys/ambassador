# Current work

## Sidebar segments, September 15

Implemented the owner's Inbox / Conversations / People segmented sidebar.
Settings and service status now sit beside the Embassys logo. People subviews
live in the sidebar; selections survive section switching. Back is now a
chevron-only button with its destination in the tooltip and accessibility label.
Controls and conversation cards have slightly rounder corners and buttons are
shorter throughout the app. Request reviews open in dialogs, keeping the
conversation and scroll position beneath them. All 53 desktop
render/artifact checks and native Mac navigation checks passed. See the
[design and test record](sidebar-segments-2026-09-15.md).

## Desktop controls, September 14

Implemented the requested replacement for accordion panels and hyperlink-style
actions. Details, advanced options and device settings open in separate sheets;
Back and Settings use compact neutral buttons. All 46 desktop view/artifact checks,
typecheck, lint and the isolated Electron interaction walkthrough passed.
See [the design and test record](desktop-controls-2026-09-14.md). These UI changes
are merged in [PR 48](https://github.com/embassys/ambassador/pull/48) and published
as [Embassys 0.1.4](https://github.com/embassys/ambassador/releases/tag/desktop-v0.1.4).
The original 0.1.3 download URLs are also restored. See [release verification](release-verification-2026-09-15.md).

## Central contract adoption, September 14

Implemented under [ADR 0082](adr/0082-current-central-recovery-and-owner-integration.md).
The [implementation and test record](central-adoption-2026-09-14.md) supersedes
archived statements that issues 1–13 still require server implementation.
Implementation and review are tracked in [PR 45](https://github.com/embassys/ambassador/pull/45).
Embassys 0.1.3 and Ambassador 0.2.20 are published and independently verified.
Embassys 0.1.4 is the latest desktop release and uses the same gateway.
API source remains unchanged.

Completed:

- CI split under [ADR 0084](adr/0084-shared-core-and-platform-ci.md): shared flows
  run once on Linux, with native components and packages checked on all four
  targets. Full local platform commands preserve end-to-end qualification.
  All new CI gates passed; the longest core job fell from 42m44s to 2m56s and
  desktop from 28m44s to 5m01s. The full Mac local script also passed.
  See [commands and evidence](ci-and-local-testing.md) and
  [PR 47](https://github.com/embassys/ambassador/pull/47), merged to main as
  `03cba12479ebd8c85ab012105eae7fb447353e56`.

- One-code desktop setup under [ADR 0083](adr/0083-one-code-desktop-setup.md):
  owner sign-in, verified first-agent creation/adoption and guarded device setup.
  [Live Claude onboarding and recovery tests passed](one-code-onboarding-2026-09-14.md).

- Durable central idempotency keys and receipt recovery, retryable acknowledgements,
  failed-custody release, same-key token renewal and explicit email recovery.
- Current owner sign-in/refresh, device selection and revocation, and private
  execution-credential installation with preserved encrypted conversations.
- Paginated requests, grants and permission history; exact reviewed decisions,
  answers and revocation; resumable account events and running-app notifications.
- People invitations and connections alongside local contact import. Importing
  or accepting a connection grants no action permissions.
- Successful-result schema validation, correlated remote progress, waiting-for-owner
  updates and persistent verification keys for explicit same-code retries.
- Private macOS push registration and visible server/provider availability, with
  running-app fallback. This does not qualify remote delivery.

Validation: 591 repository tests passed with seven expected skips; 46 desktop
artifact/render checks passed, along with typechecks, lint and production build.
The bundled Node/SQLite/ACP/MCP worker check passed. Live disposable-owner tests
passed sign-in, invitation email delivery/repeat/acceptance, connections, device
transfer, execution-token issuance, revocation and same-key email recovery.
Native sample-data checks covered People and device reviews, including Escape
and focus return. These screenshots are not evidence of live provider delivery.

Remaining:

- [ ] Qualify signed native push with configured server credentials and actual
  devices. The live server reports no push credentials. Windows still needs an
  approved native WNS bridge; Linux uses running-app notifications.
- [ ] Finish live queue-isolation qualification for account history under ADR 0085.
  The client integration and independent server contract review are implemented;
  the September 15 live run stopped at test-mailbox authentication.
- [ ] Follow the separate DPoP wire/nonce decision in issue 14. Keep the current
  protocol until a coordinated change is accepted.
- [ ] Finish the native Codex, OpenClaw and Hermes one-code button/dialog
  walkthroughs after restoring test-mailbox access. Installed-agent connection
  checks passed for all three. Claude Code needs its expired provider login
  refreshed before another connection check. The old archive helper now accepts
  the package; a complete delivery qualification still needs its documented
  central/webhook fixtures and provider configuration.

After issue 15 was deployed, protected live tests passed leased redelivery,
release/repeated acknowledgement, lost-response recovery for all four supported
agent mutations, progress/owner input, exact results, renewal and device fencing.
The test found and fixed the client's stale `delivered` expectation for central's
`queued` action receipt. The new owner roster route removes repeat sign-in after
registration and invalidates device reviews when an executor epoch changes.
Issues 16, 17, 19 and 20 are also closed and their client behavior is qualified.
The clean-installed package passed the deployed MCP/action round trip with a
controlled mock ACP target, including provider-tool approval and credential
redaction checks. Six independent Python fixture tests passed on Linux x64.
See the [retest evidence](central-adoption-2026-09-14.md#retest-after-issue-15-was-repaired).

## September 15 implementation and live Mac test

The owner approved account history, qualification tooling, provider experience
work, documentation cleanup and a live Mac end-to-end test. Changes are on
`codex/account-history-and-live-mac`; no release or server change is included.

Implemented under [ADR 0085](adr/0085-account-communication-history.md):

- Read-only owner communication pages in the private worker, exact peer grouping,
  shared sidebar conversations, local-message deduplication, older-page loading,
  retention notices and bounded memory. Account messages never enter execution
  custody. Local history deletion leaves central history unchanged.
- The qualification helper accepts the current package with a 1,024-entry bound,
  the existing 64 KiB listing limit and explicit duplicate/path rejection.
- Per-tool Embassys discovery help in the desktop relay. The native Cowork trial
  exposed an app-owned enrollment error that still said only "not enrolled".
  Initialization and all supported unenrolled tools now direct setup to the app.
- Current setup and recovery wording in guides and the app. Superseded work-plan
  material is preserved in [implementation history](implementation-history-through-2026-09-14.md),
  rather than being presented as outstanding work.

See [September 15 test evidence](account-history-and-mac-test-2026-09-15.md).
The live Mac flow reached real email verification, but Mailosaur rejected the
saved test credential with HTTP 401. The request for restored mailbox access or
an owner-supplied test address is pending. This prevents claiming the full live
flow or the remaining native provider walkthroughs passed.

Provider limitations remain explicit. Fresh Sonnet 5 Cowork still needed a
connector hint in the retest, then correctly sent setup to the app instead of
collecting a verification code in chat. OpenClaw's current upstream grouping code still accumulates
its duplicate badge across repeated renders. Hermes still requires a trusted
session key and provides interrupting injection rather than atomic idle-only
return. Foreground waits and durable later checks remain supported.

## Later work and external inputs

- Signed installers, notarization, automatic updates and launch-at-login
  qualification need release credentials and the chosen distribution channel.
- Native push needs configured APNs/WNS credentials, signed device identities
  and real-device tests. A Windows native bridge requires an approved choice.
- Real Windows/Linux/Raspberry Pi UI and provider qualification remain separate
  from CI's native component/package checks.
- Trusted engine-version selection and simultaneous independent profiles of the
  same provider need compatible signed artifacts and their own qualification.
  Existing named instances and same-build CLI/app handoffs are implemented.
- Confirm production log retention separately from the approved development
  body logs and their existing redaction, seven-day and 1 GiB limits.

The completed calendar invitation and cancellation test is recorded in the
[September 8 review](desktop-pr-review-2026-09-08.md). It is not an open API task.
