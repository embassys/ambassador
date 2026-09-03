# 0015 npm distribution

Status: accepted for packaging; package and CLI amended by ADRs 0038 and 0039

Date: 2026-08-24

Updated: 2026-09-03

## Problem

Users already have Node.js, so standalone installers would delay a usable
release without removing a current installation barrier. The public package
also needs the Embassys product name rather than the development namespace.

## Decision

Publish one public package as `@embassys/ambassador` with the `ambassador`
binary. The package requires Node.js 24.

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

Normally publish from `main` only after Linux and macOS checks, packed
installation, the five-profile local qualification matrix, live central
qualification, and artifact audits pass. ADR 0033 keeps Windows unsupported.

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
need qualification on every supported operating system. Direct mode also adds
the exact ACP SDK approved in ADR 0038.

## Approval

The user approved npm distribution, MIT licensing, Node-based execution,
trusted publishing, and the new package name on 2026-09-02. On 2026-09-03 the
user separately approved publication of version 0.2.6 with the qualification
exception described above, then approved 0.2.7 for the zero-configuration
startup correction. The user then approved 0.2.8 with the qualification gaps
and probe behavior recorded above. The user then approved the conditional 0.2.9
release described above. Later publications still require explicit approval
after qualification.

The user also approved changing public installation guidance from a pinned
Ambassador version to the npm `latest` tag on 2026-09-03. This changes only the
user-facing selection command; every publication still follows the release
approval and qualification gates above.
