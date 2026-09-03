# 0006 Toolchain

Status: accepted

Date: 2026-08-23

Updated: 2026-09-03 for the open-ended Node engine range

## Problem

The project needs strict TypeScript checks, cross-platform tests, formatting, and CI without turning a small daemon into a framework stack.

## Decision

| Area | Choice |
| --- | --- |
| Runtime | Node.js 24.19.0 or newer |
| Repository package manager | pnpm 11.22.0 through Corepack, with a committed lockfile and frozen installs |
| Language | TypeScript 7.0.2 with strict checks |
| Tests | `node:test` and `node:assert/strict` |
| Lint and format | Biome 2.5.10 |
| Runtime schemas | Zod 4.4.3 with strict objects |
| HTTP | Node `fetch`, `AbortSignal`, and Web Crypto behind a project wrapper |
| Direct agent protocol | `@agentclientprotocol/sdk` 1.4.0 under ADR 0038 |
| CLI parsing | `node:util.parseArgs` with project-owned subcommand dispatch |
| Logging | Project-owned typed NDJSON writer with allowlisted fields |
| CI | GitHub Actions on Linux, macOS, and Windows; Windows support remains gated by ADR 0040 |

Pin direct dependencies exactly. CI and release builds use Node 24.19.0 as the
reproducible minimum even when a developer has a newer release. The public npm
engine declaration is `>=24.19.0` without an upper bound. A newer Node major
must not produce an npm engine warning solely because it is newer. Qualify the
packed artifact on the current Node major before release when it differs from
the build runtime.

Pin pnpm by version and SHA-512 through `packageManager`. Keep `pnpm-lock.yaml` authoritative. Enforce a strict 24-hour minimum package release age, reject exotic transitive dependency sources, and deny dependency build scripts except for the reviewed `better-sqlite3` native build.

Tests inject clocks, random values, HTTP transports, and writers. They do not replace modules at runtime.

The HTTP wrapper owns deadlines, response-size limits, status mapping, and schema validation. It never logs a response body.

The normal logger accepts named events with typed safe fields. It does not
accept arbitrary objects, raw errors, headers, URLs, protocol bodies, or a
verbose protocol transcript.

The final npm-registry upload continues to use the exact npm CLI qualified for trusted OIDC publishing. pnpm 11's native publisher does not yet support npm trusted publishing; using it would require a long-lived token and weaken the release boundary. Repository dependency resolution, scripts, tests, audits, packing, and packed-artifact installation use pnpm. End users run the published package with `npx` as defined by ADR 0015.

## Alternatives

- npm needs no Corepack bootstrap, but its flatter dependency layout and lifecycle-script defaults provide a weaker project-level boundary.
- Vitest has a rich test API but is unnecessary for this service.
- ESLint, typescript-eslint, and Prettier add several tools where Biome and strict TypeScript are enough.
- Commander becomes useful only if the approved CLI outgrows the small grouped dispatcher.
- Ajv with TypeBox is a good fit for a larger JSON Schema codebase. Zod is smaller for the fixed messages in v1.

## Maintenance and licenses

- Node.js and Zod use the MIT license.
- TypeScript and the Agent Client Protocol TypeScript SDK use Apache-2.0.
- Biome uses MIT or Apache-2.0.
- pnpm uses MIT. npm uses Artistic-2.0 and supplies `npx` for end-user execution as well as the trusted registry publisher.

All selected projects are active as of this decision. Exact versions remain in `package.json` and `pnpm-lock.yaml`.

## Packaging impact

Biome and TypeScript are development tools. The ACP SDK is a pure JavaScript
runtime dependency. Packaging the Node runtime remains a release task.

## Approval

The user delegated the initial choice on 2026-08-23. On 2026-08-26, the user
approved the existing tools, preferred pnpm over npm for its repository
security controls, and approved immediate migration. On 2026-08-27, the user
clarified that pnpm is for repository development and release work only;
end-user usage stays on `npx`. On 2026-09-02, the user approved ACP v1 and
delegated the exact SDK choice recorded in ADR 0038.
On 2026-09-03, the user removed the Node 25 ceiling and approved a new release
with the open-ended engine declaration.
