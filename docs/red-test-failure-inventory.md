# Red test status

Status: replacement inventory required by I02

The repository's original red suite and later T03/T04 suites specified two
central contracts that ADR 0037 supersedes. Their green state does not describe
the current live server.

I02 replaces those tests and fixtures with the source-derived contract in
[`test/i02-failure-inventory.md`](../test/i02-failure-inventory.md). The new
tests must be reviewed while they fail only at absent production behavior.
Production central-client changes begin after that review.

Existing local MCP, webhook, process lock, SQLite, package, provider process,
and artifact tests remain useful where they do not assert a superseded central
route or lifecycle.

Until I02 lands:

- `pnpm test` is a repository regression signal, not current live-contract
  evidence;
- `pnpm run test:red-inventory` classifies a historical target; and
- the independent Python fixture is not the current source-derived fixture.
