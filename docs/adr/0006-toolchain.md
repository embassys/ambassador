# 0006 Toolchain

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The project needs strict TypeScript checks, cross-platform tests, formatting, and CI without turning a small daemon into a framework stack.

## Decision

| Area | Choice |
| --- | --- |
| Runtime | Node.js 24.19 LTS |
| Package manager | npm 11 with a committed lockfile and `npm ci` |
| Language | TypeScript 7.0.2 with strict checks |
| Tests | `node:test` and `node:assert/strict` |
| Lint and format | Biome 2.5.10 |
| Runtime schemas | Zod 4.4.3 with strict objects |
| HTTP | Node `fetch`, `AbortSignal`, and Web Crypto behind a project wrapper |
| CLI parsing | `node:util.parseArgs` with project-owned subcommand dispatch |
| Logging | Project-owned typed NDJSON writer with allowlisted fields |
| CI | GitHub Actions on Linux, macOS, and Windows |

Pin direct dependencies exactly. CI and release builds use Node 24 even when a developer has a newer Current release.

Tests inject clocks, random values, HTTP transports, and writers. They do not replace modules at runtime.

The HTTP wrapper owns deadlines, response-size limits, status mapping, and schema validation. It never logs a response body.

The logger accepts named events with typed safe fields. It does not accept arbitrary objects, raw errors, headers, URLs, or protocol bodies.

## Alternatives

- pnpm is fast but adds a bootstrap step and is not installed on the current development machine.
- Vitest has a rich test API but is unnecessary for this service.
- ESLint, typescript-eslint, and Prettier add several tools where Biome and strict TypeScript are enough.
- Commander becomes useful only if the approved CLI outgrows the small grouped dispatcher.
- Ajv with TypeBox is a good fit for a larger JSON Schema codebase. Zod is smaller for the fixed messages in v1.

## Maintenance and licenses

- Node.js and Zod use the MIT license.
- TypeScript uses Apache-2.0.
- Biome uses MIT or Apache-2.0.
- npm uses Artistic-2.0.

All selected projects are active as of this decision. Exact versions remain in `package.json` and `package-lock.json`.

## Packaging impact

Biome and TypeScript are development tools. Zod is the only pure JavaScript runtime dependency selected here. Packaging the Node runtime remains a release task.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
