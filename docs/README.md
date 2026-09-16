# Documentation

- [September 16 release candidate and gates](release-candidate-2026-09-16.md)

- [September 15 usernames and accepted-request adoption](central-adoption-2026-09-15.md)
- [ADR 0087: Usernames and accepted actions](adr/0087-usernames-and-accepted-actions.md)
- [September 15 release follow-up](release-readiness-2026-09-15.md)

## Start here

1. [Product and architecture](product-vision-and-architecture.md)
2. [Target protocol](protocol.md)
3. [Current work](implementation-plan.md)
4. [Architecture decisions](adr/README.md)

The architecture and protocol define the accepted target. The implementation
plan separates current implementation from outstanding work. Older status and
release evidence is preserved in dated records.

## Other records

| Need | Read |
| --- | --- |
| Download and install the desktop app | [Desktop installation](desktop-install.md) |
| Request an action, answer later, or retrieve a result | [Action workflow](action-workflow.md) |
| Review the next development fixes and conversation delivery design | [Development fixes and conversation delivery](development-fixes-and-conversation-delivery.md) |
| Review the new web app and owner API availability | [Web app and server review](desktop-web-app-review-2026-09-07.md) |
| Check closed API issues, new contracts and client adoption work | [September 14 central API review](central-api-review-2026-09-14.md) |
| Review the approved desktop product and central API requirements | [Desktop app design](desktop-app-design.md) |
| Plan desktop implementation and platform acceptance testing | [Desktop app plan](desktop-app-plan.md) |
| Switch between CLI and app using the same installation | [Shared installation](adr/0069-shared-cli-and-desktop-installation.md) |
| Build and verify desktop distribution files | [Desktop development packages](desktop-distribution.md) |
| Understand the supplied examples of users getting stuck | [Stalled-session review](stalled-session-review.md) |
| Configure foreground waits and optional native return | [Client delivery](client-delivery.md) |
| Implement the approved durable workflow and client matrix | [ADR 0061](adr/0061-durable-workflows-and-client-delivery.md) |
| Check workflow regression and live acceptance requirements | [Workflow test plan](workflow-test-plan.md) |
| Run tests or review historical evidence | [Delivery qualification](qualification.md) |
| Run shared tests, native checks or full local platform flows | [CI and local testing](ci-and-local-testing.md) |
| Check public downloads and the repaired 0.1.3 links | [September 15 release verification](release-verification-2026-09-15.md) |
| Install the renamed npm CLI and review its release checks | [Embassys CLI 0.2.21](embassys-cli-release-2026-09-15.md) |
| Check account history, provider discovery and live Mac test status | [September 15 implementation and tests](account-history-and-mac-test-2026-09-15.md) |
| Review the Inbox / Conversations / People sidebar and header controls | [Sidebar segments](sidebar-segments-2026-09-15.md) |
| Review desktop buttons, Back and separate detail sheets | [Desktop controls](desktop-controls-2026-09-14.md) |
| Review the desktop PR, Cowork discovery, OpenClaw display and real calendar invitation | [Desktop PR review](desktop-pr-review-2026-09-08.md) |
| Review native owner approvals, answers, revocation and default waits | [Owner decision qualification](owner-decisions-qualification-2026-09-08.md) |
| Review combined app onboarding, real-agent delivery and remaining client limits | [September 8 client completion](client-completion-2026-09-08.md) |
| Verify the existing live REST integration | [Live central qualification](live-qualification.md) |
| Set up Codex | [Codex setup](getting-started-codex.md) |
| Connect an agent from the app and enable natural request discovery | [Guided agent connection](guided-agent-connection.md) |
| Review the desktop refinement and People scope | [Desktop refinement](desktop-refinement-2026-09-10.md) |
| Review the simpler Inbox and History app | [Desktop simplicity](desktop-simplicity-2026-09-10.md) |
| Review current one-code setup and native test evidence | [One-code onboarding](one-code-onboarding-2026-09-14.md) |
| Review the released Mac app's live onboarding and screenshot evidence | [Native onboarding qualification](onboarding-qualification-2026-09-10.md) |
| Set up Claude Code | [Claude Code setup](getting-started-claude.md) |
| Connect standalone Claude Chat or Cowork locally | [Desktop local client](claude-desktop-local-client.md) |
| Set up Hermes | [Hermes setup](getting-started-hermes.md) |
| Set up OpenClaw | [OpenClaw setup](getting-started-openclaw.md) |
| Remove local test residue | [Local development reset](development-reset.md) |
| Track worthwhile central service changes | [Central follow-ups](central-follow-ups.md) |
| Understand an accepted design change | [ADR ledger](adr/README.md) |

The complete central service belongs in
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). This
repository documents only Ambassador behavior that depends on it. Test fixture
details live beside the fixture code under `test/fixtures/`.

Old connector setup guides and provider-specific qualification notes were
removed with the superseded implementation. Their useful decisions remain in
the ADR ledger.

## Target repository map

| Path | Contents |
| --- | --- |
| `src/` | Ambassador CLI, local MCP, REST client, credential custody, delivery modes, journal, and encrypted action inboxes |
| `test/` | Unit, integration, security, artifact, and qualification tests |
| `test/fixtures/` | Independent central fixture, mock webhook receiver, and mock ACP agent |
| `docs/adr/` | Accepted decisions and the historical ledger |

The [September 14 central adoption record](central-adoption-2026-09-14.md) lists
the newly implemented API integrations, live evidence and remaining blockers.
