# Codex App Server 0.149.0 stable schema fixture

This directory contains the stable v2 JSON Schema bundle generated from the
external Codex CLI 0.149.0 release. It is a test fixture only. It is not copied
into a connector build, staging directory, tarball, or installed package.

- Upstream project: <https://github.com/openai/codex>
- Release tag: `rust-v0.149.0`
- Source commit: `758ef40`
- License: Apache-2.0, <https://github.com/openai/codex/blob/rust-v0.149.0/LICENSE>
- Generation command: `codex app-server generate-json-schema --out <empty-directory>`
- Generated file: `codex_app_server_protocol.v2.schemas.json`
- SHA-256: `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`

The bundle was generated twice into separate empty directories from the
locally inspected 0.149.0 installation and was byte-identical. No
`--experimental` option was used. ADR 0034 records the source and qualification
limits. The generated schema is retained under its upstream Apache-2.0 terms;
the surrounding test harness remains covered by the repository license.
