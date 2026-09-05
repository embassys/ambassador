# Documentation

## Start here

1. [Product and architecture](product-vision-and-architecture.md)
2. [Target protocol](protocol.md)
3. [Current work](implementation-plan.md)
4. [Architecture decisions](adr/README.md)

The architecture and protocol define the accepted target. The implementation
plan contains only work that is not complete.

## Other records

| Need | Read |
| --- | --- |
| Request an action, answer later, or retrieve a result | [Action workflow](action-workflow.md) |
| Review the next development fixes and conversation delivery design | [Development fixes and conversation delivery](development-fixes-and-conversation-delivery.md) |
| Understand the supplied examples of users getting stuck | [Stalled-session review](stalled-session-review.md) |
| Configure foreground waits and optional native return | [Client delivery](client-delivery.md) |
| Implement the approved durable workflow and client matrix | [ADR 0061](adr/0061-durable-workflows-and-client-delivery.md) |
| Check workflow regression and live acceptance requirements | [Workflow test plan](workflow-test-plan.md) |
| Run tests or review historical evidence | [Delivery qualification](qualification.md) |
| Verify the existing live REST integration | [Live central qualification](live-qualification.md) |
| Set up Codex | [Codex setup](getting-started-codex.md) |
| Set up Claude Code | [Claude Code setup](getting-started-claude.md) |
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
