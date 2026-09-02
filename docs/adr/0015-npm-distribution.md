# 0015 npm distribution

Status: accepted for packaging; package and CLI amended by ADR 0038

Date: 2026-08-24

Updated: 2026-09-02

## Problem

Users already have Node.js, so standalone installers would delay a usable
release without removing a current installation barrier. The public package
also needs the Embassys product name rather than the development namespace.

## Decision

Publish one public package as `@embassys/ambassador` with the `ambassador`
binary. The package requires Node.js 24.

Users run the foreground process directly from a qualified npm release:

```text
npx --yes @embassys/ambassador@<qualified-version> start --local-token-env=<environment-variable>
```

Do not publish separate connector packages. Direct ACP support and its fixed
agent profiles belong in the Ambassador package. Do not retain
`@a2adev/gateway`, `a2a-gateway`, or provider connector binaries as aliases.

User-facing guides pin a qualified version. They do not require a global
install or pnpm. The repository, CI, packing, and release qualification use
pnpm under ADR 0006.

Publish from `main` only after Linux and macOS checks, packed installation,
the OpenClaw/Hermes local qualification matrix, live central qualification,
and artifact audits pass. ADR 0033 keeps Windows unsupported.

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
trusted publishing, and the new package name on 2026-09-02. Each publication
still requires explicit approval after qualification.
