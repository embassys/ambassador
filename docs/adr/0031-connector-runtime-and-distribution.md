# 0031 Connector runtime and distribution

Status: accepted

Date: 2026-08-30

Updated: 2026-08-31 for the approved public repository relocation

## Problem

ADR 0024 accepts provider connectors as products separate from the gateway.
D05 needed an exact common runtime, repository package boundary,
dependency policy, installation model, supported-platform rule, and publishing
gate before connector tests or production code begin.

The choice must not add provider code to `@a2adev/gateway`, silently install a
model runtime, copy provider credentials, or turn the repository into an
unbounded framework stack. It must also keep real provider credentials out of
CI and avoid claiming support on a platform that either the gateway or the
selected provider has not passed.

## Proposed decision

### Runtime and repository toolchain

Extend ADR 0006 to the provider-neutral connector foundation and thin provider
packages:

| Area | Proposed choice |
| --- | --- |
| Runtime | Node.js 24.19 LTS, with `>=24.19.0 <25` enforced by every package |
| Language | TypeScript 7.0.2 with strict checks |
| Repository package manager | pnpm 11.22.0 through Corepack and the existing frozen lockfile controls |
| Tests | `node:test` and `node:assert/strict` |
| Lint and format | Biome 2.5.10 |
| Validation | Zod 4.4.3 with strict objects |
| Webhook and cryptography | Project-owned bounded HTTP/1.1 parsing over Node core `node:net`, plus Web Crypto and `node:crypto` |
| Processes | Project-owned wrappers around `node:child_process`; never invoke a shell |
| Gateway MCP client | The already approved `@modelcontextprotocol/client` 2.0.0 package |
| Correlation store | `better-sqlite3` 13.0.3 only if ADR 0029 separately approves extending ADR 0007 to connector state |

Do not add a web framework, CLI framework, ORM, logging framework, job queue,
cryptography package, provider SDK, or provider executable as part of the
foundation. A provider-specific ADR may propose an SDK or executable only with
its exact version, license, protocol, release policy, and platform impact.

This accepted amendment does not itself install or update a dependency. ADR
0032 permits the exact workspace entries and lockfile changes in the K01
through K03 implementation sequence.

The connector is an MCP client, not an MCP server, and uses the client
package's approved HTTP transport. No MCP server or Node transport package is
a direct connector dependency. ADR 0030's raw request-line, framing, and
socket-accept deadlines require the small closed webhook parser over
`node:net`; it is not a reusable web server or framework. TypeScript, Biome,
Node types, and
`@types/better-sqlite3` remain repository development dependencies rather than
provider-package runtime dependencies.

### Source, build, and staging layout

Shared connector code is repository source, not a private runtime package.
Use this exact layout:

```text
packages/
  connector-core/
    src/
  codex-connector/
    src/
    package.json
    tsconfig.build.json
    README.md
    SECURITY.md
  claude-connector/
    src/
    package.json
    tsconfig.build.json
    README.md
    SECURITY.md
  gemini-connector/
    src/
    package.json
    tsconfig.build.json
    README.md
    SECURITY.md
.build/connectors/<provider>/
.stage/connectors/<provider>/
```

When K01 starts, `pnpm-workspace.yaml` must list exactly the existing root plus
`packages/codex-connector`, `packages/claude-connector`, and
`packages/gemini-connector`. `packages/connector-core` is not a package and is
not a workspace entry. The frozen lockfile must contain one importer for each
provider manifest. A missing importer, a manifest dependency absent from its
importer, or a non-frozen install fails connector checks.

The root adds one `connectors:check` command that, in order, cleans and builds
all three providers, type-checks their included common source, runs the
foundation and package tests, stages and packs each private artifact, inspects
each tarball, and performs a clean offline install and command smoke test. The
existing root `check` command and connector CI jobs invoke
`connectors:check`. Individual project commands may select one closed provider
for iteration, but the merge gate checks all three workspace importers.

`packages/connector-core` has no `package.json`, package name, exports map, or
runtime installation. Provider source imports common modules through relative
source imports such as `../../connector-core/src/index.js`. It never imports
`@a2adev/connector-core` or a `workspace:` dependency.

Each provider's checked-in `tsconfig.build.json` includes its own `src/**/*.ts`
and `../connector-core/src/**/*.ts`, sets `rootDir` to `..`, and writes to
`.build/connectors/<provider>`. TypeScript therefore preserves these two trees:

```text
.build/connectors/<provider>/
  connector-core/src/**/*.js
  <provider>-connector/src/**/*.js
```

Build and staging scripts resolve the repository root from their own checked-in
module URL, accept only one closed provider value, and operate only on literal
derived targets below that root. They reject a symbolic link in any target
parent. Before work, they remove and recreate only the selected provider's
derived target and its one literal `.tmp` sibling; they never follow a link,
use a glob, or accept a caller path. `.build/` and `.stage/` are ignored by Git.

Compilation writes first to `.build/connectors/<provider>.tmp`, validates that
there is exactly one `.js` output for each included `.ts` source and no other
file, then renames that directory to `.build/connectors/<provider>`. A failure
leaves no accepted final build tree. The project-owned staging script creates
`.stage/connectors/<provider>.tmp/package`, copies the two validated compiled
trees under `dist`, then copies that provider's checked-in `package.json`,
`README.md`, and `SECURITY.md` plus the repository `LICENSE`. It validates the
literal file inventory, modes, hashes, and expected package name before
renaming the temporary directory to `.stage/connectors/<provider>`. It does
not rewrite imports, generate a manifest, resolve a workspace dependency, or
copy another adapter. An unexpected build, stage, or packed leaf fails the
check; stale output can never be merged with a new build. Packing and
clean-install tests run only against that accepted staging directory. A
staging directory has this exact shape:

```text
.stage/connectors/<provider>/package/
  package.json
  LICENSE
  README.md
  SECURITY.md
  dist/
    connector-core/src/**/*.js
    <provider>-connector/src/**/*.js
```

No bundler or added build tool is selected. A packed artifact contains no
gateway code, other provider adapter, test fixture, transcript, state,
credential, working-directory data, or provider-runtime installer.

### Static provider manifests

The three provider manifests are checked in and reviewed separately. During
K01 through K03, each uses version `0.0.0-private` and `"private": true`.
The staging script copies it without changing those fields. Each manifest has:

- `type` set to `module`, license `MIT`, and Node engine
  `>=24.19.0 <25`;
- repository URL `git+https://github.com/embassys/ambassador.git` and its own
  `packages/<provider>-connector` repository directory;
- `publishConfig.access` set to `public`;
- one `bin` entry and no other executable;
- one exact `files` allowlist; and
- complete exact runtime dependencies, with no private, file, link, or
  `workspace:` dependency.

The provider-specific `bin` and `files` fields are:

| Package | `bin` | `files` |
| --- | --- | --- |
| `@a2adev/codex-connector` | `"a2a-codex-connector": "dist/codex-connector/src/cli.js"` | `dist/connector-core/src`, `dist/codex-connector/src`, `LICENSE`, `README.md`, `SECURITY.md` |
| `@a2adev/claude-connector` | `"a2a-claude-connector": "dist/claude-connector/src/cli.js"` | `dist/connector-core/src`, `dist/claude-connector/src`, `LICENSE`, `README.md`, `SECURITY.md` |
| `@a2adev/gemini-connector` | `"a2a-gemini-connector": "dist/gemini-connector/src/cli.js"` | `dist/connector-core/src`, `dist/gemini-connector/src`, `LICENSE`, `README.md`, `SECURITY.md` |

Each private foundation manifest contains exactly this structure, with the
closed provider substitutions from the table above:

```json
{
  "name": "@a2adev/<provider>-connector",
  "version": "0.0.0-private",
  "private": true,
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/embassys/ambassador.git",
    "directory": "packages/<provider>-connector"
  },
  "publishConfig": {
    "access": "public"
  },
  "type": "module",
  "bin": {
    "a2a-<provider>-connector": "dist/<provider>-connector/src/cli.js"
  },
  "files": [
    "dist/connector-core/src",
    "dist/<provider>-connector/src",
    "LICENSE",
    "README.md",
    "SECURITY.md"
  ],
  "engines": {
    "node": ">=24.19.0 <25"
  },
  "dependencies": {
    "@modelcontextprotocol/client": "2.0.0",
    "better-sqlite3": "13.0.3",
    "zod": "4.4.3"
  }
}
```

There is no lifecycle script, `main`, `exports`, or package-manager field in a
provider manifest. Repository commands own build, pack, audit, and test work.
The `bin` file imports only staged relative files and direct declared runtime
dependencies. Its TypeScript source and compiled JavaScript both begin with
the ASCII bytes `#!/usr/bin/env node` followed by one LF byte. Staging rejects
a missing or altered shebang. Packed-file tests require the bin target to carry an executable tar
mode on POSIX. Every claimed platform runs the actual packed `npx ... start` command
against the fake gateway and observes readiness and bounded shutdown;
importing the module directly is not a command smoke test.

The initial foundation dependency object in each manifest contains exactly
`@modelcontextprotocol/client` 2.0.0, `better-sqlite3` 13.0.3, and Zod 4.4.3.
ADR 0029's D05 approval authorizes the connector use of `better-sqlite3`. A
later provider ADR may add that provider's exact approved runtime dependency
to its own static manifest. It cannot add the dependency to the other two
manifests.

Each artifact exposes only its provider-specific foreground command approved
by ADR 0028. The gateway package, binary, CLI, dependencies, state, and release
cadence remain unchanged. There is no plugin discovery or dynamic adapter
download.

Provider packages version independently. Each release records its source
commit and provider protocol decision. A failed or withdrawn version is never
reused. Rollback selects a preceding exact version that passed the same
provider and platform gates.

### Provider runtime ownership

Users install, authenticate, update, and remove the selected Codex, Claude, or
Gemini provider runtime through that provider's normal mechanism when the
later provider ADR selects a separately installed runtime. A connector may
validate the exact interface and version approved by that ADR, but it does not
install, upgrade, log in to, or modify a separate runtime. A later ADR may
instead select an exact SDK dependency; that dependency then belongs only to
the matching static provider manifest and remains subject to the same review,
lockfile, credential, and packaging gates.

Provider credentials remain in provider-owned storage. Connector packages and
CI do not request, copy, proxy, cache, or persist them. Fake providers cover
automated protocol tests. Real-provider qualification is manual, opt-in, and
uses an existing authenticated installation in an isolated working directory.

### Installation proposal

After Q03 publishes a selected provider preview, users run its exact qualified
preview version with `npx`:

```text
npx --yes @a2adev/<provider>-connector@<qualified-version> start <approved-options>
```

Repository work, audits, packs, and clean-install qualification continue to
use pnpm. End users do not need pnpm or a global connector installation.

No distribution tooling was added during D05. Under ADR 0032, K01 through K03
may add the private static manifests, build configuration, staging script, and
local packed-install tests described above. They may not remove `private`, add
a publish job, or publish a package.

Q03 is the preview publication decision and release gate. It applies to one
selected provider that has passed Q01, Q02, its provider qualification, and
every platform gate it claims. Q03 requires separate user approval to make
the source repository public, change that provider's static manifest to
version `0.1.0`, remove `private`, select and lock one exact maintained npm CLI
version under ADR 0006's supply-chain rules, and add a provider-scoped trusted
publishing job.

The job builds from the matching public `main` commit and produces the exact
tarball that the packed-install, inventory, license, and platform jobs
qualify. Before publication it verifies the tarball digest against that
qualification output, unpacks it without running scripts, and fails unless
the manifest has the expected provider package name, expected version,
`private` absent, exact dependency object, bin target, files allowlist, and
public repository URL and directory. The qualification record binds the public
source commit to that exact tarball digest. The job then runs the locked npm CLI
with the exact verified tarball path, equivalent to
`npm publish <verified-provider.tgz> --provenance --tag next --access public`.
A bare `npm publish` or publishing from the repository or staging directory is
forbidden because it could target `@a2adev/gateway` or unqualified files.
Trusted publishing uses GitHub Actions OIDC and no long-lived registry token.
After publication, the release gate verifies that the registry provenance
subject matches the published package digest and that its predicate or source
material identifies the same public source commit. A mismatch fails the release
and prevents stable promotion; the published preview version is never reused.
If the source repository remains private, Q03 stays blocked because the
release cannot make the required public provenance claim.

Q03 publishes only the selected provider package. Another provider needs its
own completed qualification evidence and explicit Q03 release approval. A
provider change never publishes a sibling package merely because both live in
the same repository.

Q05 is the stable publication decision and release gate. After Q04, it may
approve `1.0.0` on npm's `latest` tag for each provider that has passed every
provider and platform gate it claims. Preview publication does not imply Q05
approval. A provider that has not qualified stays unpublished or remains on
`next`; it does not block a separately qualified provider unless Q05 expressly
groups them into one release decision.

There is no native installer, service definition, container runtime product,
self-updater, automatic provider installer, or global configuration file in
the first release. Rollback means selecting the preceding qualified package
version and following its documented state-compatibility boundary. The first
release has no connector-state migration, so a release that changes the state
schema requires a separate reviewed plan rather than an automatic upgrade.

### Platform qualification

Linux x64, macOS arm64, and macOS x64 are initial candidate test lanes, not a
shared support claim. Under ADR 0033, Windows x64 is not an initial-release
candidate. A provider package may advertise one of the initial candidates
only when all of these pass for that exact provider and platform:

1. the gateway's current packed-install and credential-permission checks;
2. connector unit, state, process, crash, and artifact-scan tests;
3. a clean packed installation of the exact connector artifact;
4. the fake-provider conversation chain;
5. the provider-specific exact-version qualification; and
6. hard-crash containment and recovery tests at every post-dispatch barrier.

The hard-crash tests kill the connector without graceful cancellation while a
provider root and descendants are active. Qualification must prove either that
the operating system containment mechanism terminates and reaps the complete
provider process tree when connector ownership disappears, or that the exact
approved provider interface can recover and reconcile the same turn without a
second submission while proving no orphan continues work. A normal child exit,
successful graceful shutdown, or exact-turn ID alone is not that proof.

If the selected provider interface and platform cannot meet that rule, the
package does not advertise that provider-platform pair. The candidate matrix
does not promise that a Node child-process wrapper, POSIX process group,
provider daemon, or SDK can satisfy the rule before its tests pass. A future
Windows candidate additionally requires ADR 0033's new approved plan, native
qualification, and restored CI.

An adapter advertises the intersection of the gateway, connector foundation,
Node runtime, native dependency, and provider runtime matrices. Failure on one
claimed platform narrows that adapter's documented support; it does not
silently remove a claimed platform from CI or broaden another adapter's claim.
ADR 0033's explicit Windows deferral is not such a silent removal.

CI never contains real provider credentials. Jobs that need a real provider
remain manual and local until the project approves a secure provider-owned
test identity and execution environment.

## Supply-chain and license rules

- Keep every direct version exact and use the existing lockfile, minimum
  release-age, exotic-source, and build-script controls from ADR 0006.
- Permit only the already reviewed `better-sqlite3` native build script if ADR
  0029 is accepted for connector state.
- Run license, dependency, packed-file, provenance, and clean-install checks
  for each provider artifact independently. Before Q03, provenance checks are
  local negative checks only; public npm provenance begins at the approved Q03
  publication from the public repository.
- The connector source and packages use the repository's MIT license. Record
  every provider SDK or runtime license and terms in its provider-specific
  ADR; do not imply that an external provider runtime is distributed under the
  connector's license.
- Keep the public package allowlist to compiled runtime files, package
  metadata, license, and provider-specific setup and security documentation.

## Alternatives

- Put all adapters in `@a2adev/gateway`. This violates ADR 0024 and couples
  central identity custody to provider dependencies.
- Publish one connector package with three binaries. It gives every user all
  adapter dependencies and makes one provider's release affect the others.
- Publish connector core as a public runtime package. This reduces packed
  duplication but creates another supported public API and coordinated
  registry dependency without a user-facing benefit.
- Build standalone native executables. This removes the Node prerequisite but
  adds a bundler, signing, notarization, larger platform artifacts, and another
  update path before demand justifies them.
- Use containers for the product. Containers complicate access to local
  provider credentials, tools, working directories, and approval surfaces.

## Costs and risks

Separate provider packages add manifests, packed-install lanes, and release
records. Compiling the shared source into each artifact duplicates code, but
keeps installs independent and avoids a private runtime package that npm or
`npx` would still need to resolve. `better-sqlite3` keeps a native packaging
obligation if ADR 0029 extends its use. Users still need Node 24 and a
separately installed provider runtime.

Independent versions can drift. Exact provider protocol ADRs, provenance and
release records that bind the source commit, fake-provider compatibility
tests, and per-artifact release gates are required to keep the boundary
reviewable.

## Approval

Approved by the user on 2026-08-30. This accepts the D05 runtime, private
package layout, installation model, dependency scope, and platform
qualification rules. With ADRs 0028 through 0030, it completes D05. K01
through K03 were originally gated on G04. ADR 0032 now permits that local work
against the accepted fixture contract.

The user separately approved making the source public at
`https://github.com/embassys/ambassador` on 2026-08-31. That approval changes
the repository location only. It does not authorize a publish job, preview or
stable publication, or provider/platform support claim. Those stay behind
Q03, Q05, and the provider qualification gates. It adds no state migration; a
later state-schema change requires a separate reviewed plan and cannot migrate
a first-release store automatically.
