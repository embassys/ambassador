# Architecture decisions

Read ADR 0037 for central integration, ADR 0038 for local delivery, ADR 0039
for zero-configuration local startup, and ADR 0041 for agent-version handling.

## Current decisions

| ADR | Decision |
| --- | --- |
| [0006](0006-toolchain.md) | Repository toolchain |
| [0007](0007-sqlite.md) | SQLite for the ID-only journal |
| [0012](0012-http-deadlines.md) | HTTP and delivery deadlines |
| [0014](0014-lock-handoff-timeout.md) | Process lock handoff |
| [0015](0015-npm-distribution.md) | Ambassador npm distribution; 0.2.6 through 0.2.9 qualification exceptions |
| [0018](0018-mcp-sdk.md) | MCP SDK for local MCP |
| [0019](0019-central-credential-storage.md) | Encrypted central credential |
| [0020](0020-in-memory-central-test-service.md) | Independent central test fixtures |
| [0033](0033-defer-windows-support.md) | Windows deferral |
| [0037](0037-live-central-rest-contract.md) | Current Embassys REST integration |
| [0038](0038-ambassador-delivery-modes.md) | Guided webhook and direct ACP delivery |
| [0039](0039-zero-configuration-local-start.md) | Zero-configuration start and local-machine trust boundary |
| [0041](0041-agent-versions-are-observational.md) | Known agent names with observational versions |

## Historical ledger

Superseded ADR files remain in this directory as a design diary while their
implementation is being removed. They do not define target behavior. Git
history retains older records that have already been deleted.

| ADR | Historical decision | Replaced by |
| --- | --- | --- |
| 0017 | One ID-only webhook configured on the CLI | ADR 0038 delivery profile and full-message delivery |
| 0021 | Python-literal central MCP result normalization | ADR 0037 REST integration |
| 0022 | Temporary development transcript | ADR 0037 and normal safe errors |
| 0023 | Proposed enrollment and recovery API | Current server routes in ADR 0037 |
| 0024 | Separate provider session connector | ADR 0038 gateway-owned ACP client |
| 0025 | Proposed conversation, reply, and lease protocol | Current permission and action model |
| 0026 | Proposed versioned DPoP and token lifecycle | Deployed DPoP behavior in ADR 0037 |
| 0027 | Proposed version 2 cutover | Current-only REST client in ADR 0037 |
| 0028 | Connector startup and retirement CLI | ADR 0038 Ambassador registration flow |
| 0029 | Connector conversation-correlation database | ADR 0038 bounded delivery state |
| 0030 | Connector conversation execution contract | ADR 0038 webhook and ACP delivery |
| 0031 | Separate connector packages | ADR 0038 single Ambassador package |
| 0032 | Fixture-first work before server deployment | Completed live REST integration |
| 0034 | Codex App Server connector | ACP profile under ADR 0038 |
| 0035 | Claude Code headless connector | ACP profile under ADR 0038 |
| 0036 | Gemini connector evaluation | Native Gemini ACP profile under ADR 0038 |

Add an ADR when changing a public CLI, dependency, trust boundary, credential
location, content-persistence rule, central transport, or agent-execution
safety property. Routine server contract updates may amend ADR 0037 and the
protocol instead of creating an API generation number.
