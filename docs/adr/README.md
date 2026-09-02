# Architecture decisions

Read ADR 0037 first for central integration work.

## Current decisions

| ADR | Decision |
| --- | --- |
| [0006](0006-toolchain.md) | Repository toolchain |
| [0007](0007-sqlite.md) | SQLite for the ID-only journal |
| [0012](0012-http-deadlines.md) | HTTP deadlines |
| [0014](0014-lock-handoff-timeout.md) | Process lock handoff |
| [0015](0015-npm-distribution.md) | npm distribution, subject to publication approval |
| [0017](0017-single-webhook-gateway.md) | Single-webhook gateway boundary |
| [0018](0018-mcp-sdk.md) | MCP SDK for local MCP |
| [0019](0019-central-credential-storage.md) | Encrypted central credential |
| [0020](0020-in-memory-central-test-service.md) | Independent central test fixtures |
| [0028](0028-connector-startup-interface.md) | Connector startup interface |
| [0031](0031-connector-runtime-and-distribution.md) | Connector runtime and distribution |
| [0033](0033-defer-windows-support.md) | Windows deferral |
| [0034](0034-codex-app-server-adapter.md) | Codex App Server adapter |
| [0035](0035-claude-code-headless-cli-adapter.md) | Claude Code headless adapter |
| [0036](0036-gemini-cli-interface-evaluation.md) | Rejected Gemini CLI interface |
| [0037](0037-live-central-rest-contract.md) | Current Embassys REST integration |

## Pending connector redesign references

ADRs [0024](0024-provider-session-connectors.md),
[0029](0029-connector-correlation-state.md), and
[0030](0030-connector-execution-contract.md) preserve provider separation,
storage, policy, process containment, and uncertain-outcome decisions. Their
conversation-oriented central workflow is not current. The connector redesign
must amend or replace those sections before live use.

## Historical ledger

Git history retains the full text of discarded designs. They are omitted from
the current documentation because none defines supported behavior.

| ADR | Historical decision | Replaced by |
| --- | --- | --- |
| 0021 | Python-literal central MCP result normalization | ADR 0037 REST integration |
| 0022 | Temporary development transcript | ADR 0037 and normal safe errors |
| 0023 | Proposed enrollment and recovery API | Current server routes in ADR 0037 |
| 0025 | Proposed conversation, reply, and lease protocol | Current permission and action model |
| 0026 | Proposed versioned DPoP and token lifecycle | Deployed DPoP behavior in ADR 0037 |
| 0027 | Proposed version 2 cutover | Current-only client in ADR 0037 |
| 0032 | Fixture-first work before server deployment | Completed live REST integration |

Add an ADR when changing a public CLI, dependency, trust boundary, credential
location, content-persistence rule, central transport, or provider-execution
safety property. Routine server contract updates may amend ADR 0037 and the
protocol instead of creating a new generation number.
