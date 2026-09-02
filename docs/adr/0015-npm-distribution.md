# 0015 npm distribution

Status: accepted for packaging; compatibility language superseded by ADR 0037

Date: 2026-08-24

Updated: 2026-08-27 for `npx` end-user execution

## Problem

The initial distribution plan required standalone files before public beta. Current users already have Node.js, so that work would delay a usable release without removing a real installation barrier.

## Decision

Publish the public package as `@a2adev/gateway` with the `a2a-gateway` binary. Version 1 requires Node.js 24.

Users run the foreground gateway directly from the npm registry with `npx`:

```text
npx --yes @a2adev/gateway@<qualified-version> start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

User-facing guides pin the qualified gateway version. They do not require a global gateway or pnpm installation. The repository, CI, packing, and release qualification continue to use pnpm under ADR 0006.

Publish initial production releases from the `main` branch only after Linux and macOS checks pass. ADR 0033 makes Windows unsupported and excludes Windows qualification from initial-release artifact evidence. The platform-neutral npm package is not a Windows-qualified artifact or support claim. Use npm trusted publishing with GitHub Actions OIDC and no long-lived publish token. A main push publishes only a new version from `package.json`; it skips a version that already exists.

Versions `0.2.0` through `0.2.6` are historical development publications.
ADR 0037 removes their central compatibility paths from the current target.
They are not a supported fallback and the next publication needs explicit
approval after current live qualification.

Keep containers for acceptance tests. Defer standalone files, native installers, package-manager manifests, signing, notarization, and a self-updater until users need a Node-free installation.

## Security

Publish a minimal tarball containing built runtime files and package
documentation. Do not retain an old central client, old credential reader, or
legacy bridge solely for upgrade compatibility. Test and audit a pnpm
installation of the tarball with strict release-age, exotic-subdependency,
and build-script policies before publishing. Keep exact dependency versions
and publish from a GitHub-hosted runner with npm provenance.

After trusted publishing works, configure npm to require two-factor authentication and disallow traditional tokens for package publishing.

## Costs

Users need Node.js 24 with npm and `npx`. Native `better-sqlite3` binaries remain part of the temporary package installation and need qualification on every supported operating system.

The current private GitHub repository can use trusted publishing, but npm cannot generate public provenance attestations until the repository is public.

## Approval

The user approved npm distribution, the public package name, MIT licensing,
Node-based end-user installation through `npx`, and trusted publishing. pnpm
remains repository tooling. Each new publication still requires explicit
approval after qualification.
