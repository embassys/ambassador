# 0086. Embassys npm package and command

Status: accepted, September 15, 2026.

The owner requested `npm install -g embassys` and the `embassys` terminal
command, then confirmed ownership of the existing placeholder and its trusted
publisher configuration. This supersedes the public package and command names
in ADR 0037 and earlier CLI records.

Publish the gateway as `embassys`, beginning with 0.2.21. Its only npm binary is
`embassys`, pointing to `dist/cli.js`. With no arguments it starts the foreground
server, exactly like `embassys start`. Keep explicit start, its optional
`--verbose`, clean, webhook-secret and session commands. Unknown arguments still
fail before reading state or making requests. Do not add a wrapper package or
an `ambassador` binary alias. Existing published packages remain untouched.

Keep the established state directories, encrypted file formats, singleton lock,
MCP server/configuration names, provider profiles and desktop handoff protocol.
Renaming installation and terminal commands must not require another email
verification, duplicate MCP connections or a new owner account. Desktop remains
a separate package and release.

Update current setup guides, recovery commands, candidate validation and CI
installation paths. Preserve dated qualification records as historical evidence.
Existing npm OIDC publication through `cli.yml` stays gated by shared tests,
the independent REST fixture and package checks on all four platforms.

Before implementation, update regression expectations for the package/binary,
default startup, invalid arguments and installed command paths. Validate a
global npm installation from the packed candidate, MCP startup and graceful
shutdown in an isolated home, and the existing shared-state handoff tests.
After publication, verify registry metadata and install the published package
to confirm the intended user command works.
