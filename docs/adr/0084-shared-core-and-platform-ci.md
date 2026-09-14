# 0084. Shared core tests and isolated platform checks

Status: accepted, September 14, 2026.

The owner requested one shared core suite covering every workflow, with only
OS-dependent behavior repeated in CI. Full platform flow scripts remain available
for local qualification. This supersedes the repeated full-suite CI requirements
in ADRs 0040, 0076 and 0081. It does not change runtime behavior or public CLI flags.

The last release spent 41 minutes in the Windows core suite and another 23 minutes
repeating desktop and business tests. Linux ran the same shared suite in about
2.5 minutes. The repeated native file-permission operations account for much of
the Windows cost; increasing job timeouts does not address the duplication.

## Decision

- Run all shared protocol, workflow, recovery, owner, UI and provider-fixture tests
  once on Linux, together with lint, typechecking and desktop rendering tests.
  Keep the independent Docker REST fixture and installed-package business flow
  on Linux. No workflow coverage is deleted.
- Put native tests in `test/platform/`. Run them on macOS, Windows, Linux x64 and
  Linux ARM64. Cover private storage and links, real Windows DACLs or POSIX modes,
  P-256 generation/serialization/signing, SQLite and process-lock ownership.
  Real platform security is never replaced by a mock in this suite.
- Install the packed npm artifact on every target and check its native SQLite
  module and actual command shim. Only Linux repeats the installed business flow.
- Keep desktop builds, archive checks, native worker/host startup and shutdown,
  and architecture checks on every target. These are platform boundaries, not
  repeated permission or account scenarios. Move the full CLI/app handoff flow
  and Mac resource measurement to local qualification.
- Keep `pnpm test` as the complete local suite. Explicit core/platform selections
  fail when empty or invalid. Newly added shared tests enter core automatically;
  newly added platform tests enter the native matrix automatically.
- Provide one cross-platform local qualifier with explicit macOS, Windows and
  Linux aliases. It runs the full tests, clean-installed CLI flow, desktop build,
  archive/runtime checks and CLI/app handoff, recording stage timings and failure.
  It refuses CI execution. Real agents and production APIs remain separate,
  explicitly controlled qualification.
- Stop duplicate desktop branch-plus-PR runs. Use PR, main and manual triggers,
  and cancel superseded PR runs while preserving main publication runs.

The npm publication job must depend on the shared core, independent REST fixture
and every platform package check. Desktop download retention still requires its
native artifact checks. Release approval, signing limits and independent download
verification remain unchanged. The existing Node, pnpm, compiler, test runner,
GitHub actions and dependency pins are retained.

Compare actual job timings after the first CI run. Do not describe local macOS
checks as Windows or Linux qualification.
