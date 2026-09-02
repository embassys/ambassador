# Red test status

Status: I02 replacement complete on 2026-09-02

The repository's original red suite and later T03/T04 suites specified two
central contracts that ADR 0037 supersedes. Their green state does not describe
the current live server.

I02 replaced those tests and fixtures with the source-derived contract in
[`test/i02-failure-inventory.md`](../test/i02-failure-inventory.md). The new
tests were reviewed at the absent-production boundary and now pass against the
completed I03/I04 implementation.

Existing local MCP, webhook, process lock, SQLite, package, provider process,
and artifact tests remain useful where they do not assert a superseded central
route or lifecycle.

Current classification:

- `pnpm test` runs the current gateway contract plus unaffected regressions;
- `pnpm run test:red-inventory` retains only the reviewed K02, CX02, and CL02
  provider-side inventories; and
- the independent Python fixture and packed Docker E2E use the current REST
  contract.
