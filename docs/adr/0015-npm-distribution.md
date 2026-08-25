# 0015 npm distribution

Status: accepted

Date: 2026-08-24

## Problem

The initial distribution plan required standalone files before public beta. Current users already have Node.js, so that work would delay a usable release without removing a real installation barrier.

## Decision

Publish the public package as `@a2adev/gateway` with the `a2a-gateway` binary. Version 1 requires Node.js 24.

Users may try temporary commands with `npx @a2adev/gateway`. Normal operation uses a global installation so the foreground command resolves to a stable executable:

```text
npm install --global @a2adev/gateway
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

Publish from the `main` branch only after Linux, macOS, and Windows checks pass. Use npm trusted publishing with GitHub Actions OIDC and no long-lived publish token. A main push publishes only a new version from `package.json`; it skips a version that already exists.

Keep containers for acceptance tests. Defer standalone files, native installers, package-manager manifests, signing, notarization, and a self-updater until users need a Node-free installation.

## Security

Publish a minimal tarball containing built runtime files and package documentation. Test that tarball before publishing. Keep exact dependency versions and publish from a GitHub-hosted runner with npm provenance when the source repository is public.

After trusted publishing works, configure npm to require two-factor authentication and disallow traditional tokens for package publishing.

## Costs

Users need a user-owned Node.js 24 and npm installation. Global installation must not require elevation. Native `better-sqlite3` binaries remain part of npm installation and need qualification on every supported operating system.

The current private GitHub repository can use trusted publishing, but npm cannot generate public provenance attestations until the repository is public.

## Approval

The user reviewed and approved npm-first distribution, package scope, initial version `0.1.0`, MIT licensing, and trusted publishing on 2026-08-24.
