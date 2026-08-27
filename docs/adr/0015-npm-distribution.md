# 0015 npm distribution

Status: accepted

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

Publish production releases from the `main` branch only after Linux, macOS, and Windows checks pass. Use npm trusted publishing with GitHub Actions OIDC and no long-lived publish token. A main push publishes only a new version from `package.json`; it skips a version that already exists.

The user approved `0.2.0` through `0.2.6` as development-only exceptions on npm's `latest` tag after Linux and macOS qualification. Windows packaging and credential permissions remain unqualified, so their documentation excludes Windows and does not present these versions as production releases.

Keep containers for acceptance tests. Defer standalone files, native installers, package-manager manifests, signing, notarization, and a self-updater until users need a Node-free installation.

## Security

Publish a minimal tarball containing built runtime files and package documentation. Releases after `0.2.0` keep the packaged Hermes bridge only so existing development installations can upgrade without breaking their configured loopback target; new setup does not use it. Test and audit a pnpm installation of the tarball with strict release-age, exotic-subdependency, and build-script policies before publishing. pnpm 11 applies the age and exotic-source checks to user installs by default, with non-strict age handling so an explicitly selected new gateway release can install. Keep exact dependency versions and publish from a GitHub-hosted runner with npm provenance when the source repository is public.

After trusted publishing works, configure npm to require two-factor authentication and disallow traditional tokens for package publishing.

## Costs

Users need Node.js 24 with npm and `npx`. Native `better-sqlite3` binaries remain part of the temporary package installation and need qualification on every supported operating system.

The current private GitHub repository can use trusted publishing, but npm cannot generate public provenance attestations until the repository is public.

## Approval

The user reviewed and approved npm-registry distribution, package scope, initial version `0.1.0`, MIT licensing, and trusted publishing on 2026-08-24. On 2026-08-25, the user selected stable `0.2.0` on the `latest` tag for the explicitly development-only Linux/macOS flow while Windows remains unqualified. On 2026-08-26, the user approved the `0.2.1` dual-authentication patch, pnpm for repository tooling, and the `0.2.2` central compatibility release under the same qualification boundary. On 2026-08-27, the user requested the live central compatibility releases through `0.2.5`, including a temporary MCP polling fallback while the public REST route is unavailable, then approved `0.2.6` with the temporary development transcript under the same qualification boundary. The same day, the user clarified that end-user usage stays on `npx`; pnpm is only for repository development and release work.
