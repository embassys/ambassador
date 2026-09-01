# Architecture decisions

## Current central authority

- [0037 Live central REST contract](0037-live-central-rest-contract.md) is the
  current central integration decision.
- [0017 Single-webhook gateway](0017-single-webhook-gateway.md) defines the
  product and local boundary.
- [0019 Central credential storage](0019-central-credential-storage.md)
  defines encrypted token/key custody.
- [0020 In-memory central test service](0020-in-memory-central-test-service.md)
  defines the replacement fixture strategy.

## Other active decisions

- 0006 toolchain
- 0007 SQLite
- 0012 HTTP deadlines
- 0014 lock handoff timeout
- 0015 npm distribution, subject to a new publication approval
- 0018 MCP SDK for the local MCP boundary
- 0024 provider process separation, amended for current central semantics
- 0028 connector startup interface
- 0029 connector correlation state, pending current-message recheck
- 0030 provider execution safety, with central lifecycle sections superseded
- 0031 connector runtime and distribution
- 0033 Windows deferral
- 0034 Codex App Server adapter
- 0035 Claude Code headless CLI adapter
- 0036 Gemini CLI interface rejection

## Superseded central decisions

ADRs 0021, 0022, 0023, 0025, 0026, 0027, and 0032 are superseded by ADR
0037. They remain in the repository as history and do not define current work.

The earlier central portions of ADRs 0017, 0019, 0020, 0024, and 0030 are
amended by ADR 0037. Read the current record first.

## Decision rule

Add a new ADR when changing a public CLI, dependency, trust boundary,
credential location, content-persistence rule, central source pin, or
provider-execution safety property. Do not turn a temporary server limitation
or fixture behavior into a permanent architecture requirement without user
review.
