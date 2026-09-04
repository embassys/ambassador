# 0015 npm distribution

Status: accepted for packaging; amended by ADRs 0038, 0039, 0043, and 0044

Date: 2026-08-24

Updated: 2026-09-03

## Problem

Users already have Node.js, so standalone installers would delay a usable
release without removing a current installation barrier. The public package
also needs the Embassys product name rather than the development namespace.

## Decision

Publish one public package as `@embassys/ambassador` with the `ambassador`
binary. The package requires Node.js 24.19.0 or newer. Its npm engine range has
no upper bound; newer Node majors should fail only for an actual runtime or
native-dependency incompatibility, not a package-metadata ceiling.

Users run the foreground process directly from npm's current `latest` release:

```text
npx --yes @embassys/ambassador@latest start
```

Do not publish separate connector packages. Direct ACP support and its fixed
agent profiles belong in the Ambassador package. Do not retain
`@a2adev/gateway`, `a2a-gateway`, or provider connector binaries as aliases.

User-facing guides select `latest` and disclose any open qualification work.
They do not require a global install or pnpm. The repository, CI, packing, and
release qualification use pnpm under ADR 0006.

Normally publish from `main` only after Linux, macOS, and Windows checks,
packed installation, the four-profile local qualification matrix, live central
qualification, and artifact audits pass. ADR 0040 requires separate native
evidence before documenting any agent profile and mode as supported on
Windows. Published Ambassador 0.2.8 and 0.2.9 predate that evidence and have no
Windows support claim.

`@embassys/ambassador@0.2.6` was a one-release exception: on 2026-09-03 the user
explicitly approved publication after the deterministic CI, package, fixture,
and live Codex evidence, but before the remaining six supported real-agent
cases and the
supported-Node repeat of the Codex case. Keep those gaps visible as
post-release qualification work. This exception does not relax the gate for a
later version. The user separately approved 0.2.7 on 2026-09-03 to remove the
local token and correct the installation path. It inherits the same disclosed
qualification gap; it does not count as completing the matrix.

The user separately approved 0.2.8 on 2026-09-03 after Hermes Agent 0.20.5
passed both live delivery modes and the supported-Node repository checks
passed. Version 0.2.8 adds the exact qualified Hermes ACP identity and changes
the local agent-version command to an observational probe. It does not weaken
the production `clientInfo` or ACP `agentInfo` allowlists. This release retains
the four open profile/mode cases and the supported-Node Codex repeat as a
disclosed qualification exception.

ADR 0041 supersedes that production version-gating policy for the 0.2.9
release. On 2026-09-03, the user requested another release and directed that
the pull request be merged once green. That authorizes the main-branch OIDC
publication of 0.2.9 only after the local candidate checks and required Linux,
macOS, package, and central-fixture pull-request gates pass. The disclosed
four-case real-agent qualification gap remains unchanged. Those gates passed,
the release workflow published 0.2.9, and the downloaded registry artifact was
verified independently.

The user separately approved another release on 2026-09-03 for the internal
webhook-secret workflow, package-shipped OpenClaw receiver, production-only
central URL, and name-based agent compatibility policy. Version 0.2.10 may be
published only after the repository and package checks pass and Hermes Agent
0.20.5 plus OpenClaw 2026.8.2 pass both live-central delivery modes against the
same byte-final candidate. Claude Code direct and Gemini CLI direct remain a
disclosed qualification exception. The user directed that the pull request be
merged when green; normal main-branch OIDC publication and post-publication
registry-artifact verification still apply.

Those conditions passed. PR 21 merged on 2026-09-03, all main-branch gates
passed, the OIDC job published 0.2.10 with the npm `latest` tag, and the
registry artifact was independently downloaded and verified. Digests and
artifact checks are recorded in the qualification document.

Later on 2026-09-03, the user approved another release that removes the
Ambassador-specific OpenClaw plugin and sends the fixed OpenClaw profile to its
native `/hooks/agent` endpoint. Version 0.2.11 may publish only after repository
and package checks pass and the byte-final candidate completes the live-central
correlated-result webhook flow with both OpenClaw and Hermes. The user directed
that the pull request merge when green. Main-branch OIDC publication and
post-publication registry-artifact verification still apply.

Those conditions passed. PR 23 merged on 2026-09-03, all main-branch gates
passed, the OIDC job published 0.2.11 with the npm `latest` tag, and the
registry artifact was independently downloaded and verified. Digests and
artifact checks are recorded in the qualification document.

ADR 0043 removes Gemini CLI from the current source registry and defers
Antigravity. Historical release evidence above continues to describe the
artifacts that were published at the time. A future publication from the
current source uses the four-profile release matrix.

ADR 0044 added the option-free `ambassador clean` command. It does not change
the package name, binary, dependency set, or release gate. Published 0.2.11
does not gain the command retroactively; published 0.2.12 contains it.

On 2026-09-03, the user approved version 0.2.12 to publish the local clean
command and its documentation. The release may publish only after the
byte-final candidate passes the repository suite, cross-platform package
installation, installed-CLI cleanup E2E, live qualification, and artifact
audits. Pull-request and main-branch gates must pass before and after merge.
The downloaded npm artifact must then be checked independently and recorded.

Those conditions passed. PR 26 merged on 2026-09-03, all main-branch gates
passed, and the OIDC job published 0.2.12 with the npm `latest` tag. The
independently downloaded registry artifact matched npm's integrity metadata and
the candidate file tree, then passed clean-install, cleanup E2E, vulnerability,
and signature checks. Its digests and results are recorded in the qualification
document.

Later on 2026-09-03, the user approved version 0.2.13 to remove the `<25`
engine ceiling. This metadata and documentation release keeps Node 24.19.0 as
the reproducible build floor and changes the public engine range to
`>=24.19.0`. It may publish after the repository suite, cross-platform package
jobs, Docker central fixture, artifact audits, and a clean packed-artifact run
on Node 26 pass. The compiled runtime and central contract are unchanged, so
the existing live-central and real-agent evidence remains applicable.

The user then approved version 0.2.14 for ADR 0045: package-owned Codex and
Claude Code adapters, bounded startup and child-process diagnostics, printed
agent setup guidance, model-oriented tool descriptions, and the pending
permission-request projection. This release may publish after repository,
cross-platform package, Docker central-fixture, installed-artifact, production
audit, and mock delivery checks pass. The central REST and DPoP wire contract
does not change, so the existing live-central evidence remains applicable. The
downloaded registry artifact must be checked after the main-branch OIDC job
publishes it.

On 2026-09-04, the user approved version 0.2.15 for the encrypted
unanswered-action inbox and ADR 0047 reliability cutover. The release replaces
the Claude adapter dependency with Ambassador's built-in Claude CLI bridge,
keeps the Codex adapter, exposes one stable MCP catalog, and pauses only the
affected relay after a local delivery failure. Publication requires the full
repository and package gates plus a real Codex-to-Claude permission and action
round trip. Temporary qualification tracing and multi-instance overrides must
not be present in the published artifact.

Those conditions passed. PR 30 merged on 2026-09-04, all main-branch gates
passed, and the OIDC job published 0.2.15 with the npm `latest` tag. The
independently downloaded registry artifact matched npm's integrity metadata and
the qualified candidate file tree, then passed clean-install, installed-CLI,
artifact-scan, and signature checks. Its digests and results are recorded in
the qualification document.

Use npm trusted publishing with GitHub Actions OIDC and no long-lived publish
token. A main push publishes only a new version from `package.json` and skips
an existing version.

Versions 0.2.0 through 0.2.6 under the old package name are historical
development publications. They are not a fallback or migration source. A new
publication requires separate user approval.

Keep containers for acceptance tests. Defer standalone files, native
installers, package-manager manifests, signing, notarization, and a self-updater
until users need a Node-free installation.

## Security

Publish a minimal tarball containing built runtime files and package
documentation. Do not retain an old central client, connector, credential
reader, package alias, or bridge for compatibility.

Test and audit a pnpm installation of the tarball with strict release-age,
subdependency, and build-script policies. Keep exact dependency versions and
publish with npm provenance. Configure npm to require two-factor authentication
and disallow traditional publish tokens after trusted publishing works.

## Costs

Users need Node.js 24 with npm and `npx`. Native `better-sqlite3` binaries
need qualification on every supported operating system. Direct mode adds the
exact ACP SDK approved in ADR 0038. Ambassador packages the Codex adapter and
its small Claude CLI bridge so users do not install separate ACP adapters.

## Approval

The user approved npm distribution, MIT licensing, Node-based execution,
trusted publishing, and the new package name on 2026-09-02. On 2026-09-03 the
user separately approved publication of version 0.2.6 with the qualification
exception described above, then approved 0.2.7 for the zero-configuration
startup correction. The user then approved 0.2.8 with the qualification gaps
and probe behavior recorded above. The user then approved the conditional
0.2.9 release described above, followed by the conditional 0.2.10, 0.2.11,
0.2.12, 0.2.13, 0.2.14, and 0.2.15 releases described above. Later
publications still require explicit approval after qualification.

The user also approved changing public installation guidance from a pinned
Ambassador version to the npm `latest` tag on 2026-09-03. This changes only the
user-facing selection command; every publication still follows the release
approval and qualification gates above.
