# Embassys CLI 0.2.21

The owner approved the npm package and command rename and confirmed ownership
of the `embassys` placeholder with trusted publishing configured.
[PR 50](https://github.com/embassys/ambassador/pull/50) merged as
`4b7219a38256ea6169cf0114e17282debf1fa218`.

Install with Node.js 24.19.0 or newer:

```sh
npm install -g embassys
embassys
```

Bare `embassys` starts the foreground server. Explicit start, verbose start,
clean, webhook-secret and session commands remain. Existing registration,
state directories, MCP configuration and app/CLI handoff are preserved.
The older scoped package and previous releases were not changed. This release
does not publish a new desktop download.

## Checks and publication

- Shared core: 587 passed, four expected skips. Mac platform checks: 22 passed,
  two expected skips. Desktop: 53 tests, typecheck, build and bundled
  Node/SQLite/ACP/MCP worker checks passed.
- The candidate passed global npm installation and real terminal-command
  startup in an isolated home, authenticated session listing, same-state
  restart, graceful shutdown and clean with diagnostic retention.
- The clean-installed business flow and command/native checks passed using
  the CI installation layout. Existing CLI/app handoff regression coverage
  passed in the shared suite.
- All ten PR checks passed. The main
  [CLI release workflow](https://github.com/embassys/ambassador/actions/runs/34974992923)
  passed its core, Docker, four-platform package and npm publication gates.
  The separate
  [desktop workflow](https://github.com/embassys/ambassador/actions/runs/34974992928)
  passed on all four targets.

npm accepted the upload at 13:30:12 UTC and reports publication at
`2026-09-15T13:36:24.207Z`. Registry processing initially left the placeholder
as latest. An early tarball 404 was cached for 300 seconds; the final check
waited for the ordinary download URL to work. npm documents this asynchronous
[publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
A successful upload alone is not an installability check.

After processing, a fresh global install by the public package name, with a
fresh npm cache and isolated prefix, installed `embassys@0.2.21`. The installed
`embassys` command passed the same startup, session, restart, shutdown and clean
checks on macOS with Node 24.19.0. No test used the owner's registration or
stopped an existing server.

## Public artifact

The registry's `latest` tag is `0.2.21`. Metadata declares exactly
`{"embassys":"dist/cli.js"}` as its binary and `>=24.19.0` as its Node requirement.
The archive's SHA-1 and SHA-512 match the registry metadata. It has GitHub
Actions provenance using the SLSA v1 predicate.

- [npm package](https://www.npmjs.com/package/embassys)
- [Published archive](https://registry.npmjs.org/embassys/-/embassys-0.2.21.tgz)
- SHA-256: `732f0352a6dd53e1066d86d3f786aacf8d1b5095be14d27032dbb58135c6ab93`
- Integrity: `sha512-97aFblzFxQy5hq0a7R3apK2XT8AoHbFkGsa1/7b4V8CMA15YL6SFM8ifyxXFERuZWNE5aiuzZWRlVPuws3VUaQ==`

Local evidence is retained under `.build/embassys-cli/`, including the core
and desktop logs, installed-flow results, public metadata and both global
command reports. Temporary installs and isolated test homes were removed.
