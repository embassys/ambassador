# 0002 Distribution

Status: superseded by ADR 0015

Date: 2026-08-23

## Problem

Developers need a fast install path, while regular users should not have to install Node or keep a terminal open. The release also needs to install a per-user background service on macOS, Linux, and Windows.

## Options

- Publish only to a JavaScript package registry. This is simple but makes Node a user prerequisite.
- Publish signed standalone files. This removes the runtime prerequisite but adds a build and signing pipeline.
- Build native installers first. This gives the most polished setup but slows early testing and triples platform work.
- Use a container as the product install. This is reproducible but does not fit a sidecar that talks to user-level runtimes and OS services.

## Decision

Use staged distribution:

1. During development, run from the repository and prepare an installable Node package.
2. Before public beta, publish signed standalone files for supported operating systems and architectures.
3. Add Homebrew, WinGet or Scoop, and Linux package manifests that install the same signed files.
4. Keep containers for acceptance tests and server-style deployments, not as the primary desktop install.

`a2a-gateway start` registers its per-user service on first use, then starts the daemon. Package managers install files but do not silently start it.

Do not add a self-updater in v1. Package managers or explicit installer runs own upgrades.

## Costs

The development package and final standalone release need separate install tests. Signing and notarization require platform credentials that are not available in this repository.

## Maintenance and license

No packaging tool has been selected yet. Its license, release activity, cross-platform support, and artifact provenance must be recorded before adoption.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
