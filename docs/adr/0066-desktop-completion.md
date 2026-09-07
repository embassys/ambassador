# 0066 Desktop work independent of central API changes

Status: accepted; setup dependencies and retention approved in ADR 0067

Date: 2026-09-07

The user requested all remaining work that can proceed without central API
changes. Continue the approved desktop plan: setup helpers, local lifecycle and
integrity checks, packaging, native tests and provider qualification. No server
changes, publication, provider credential access or migration is authorized.

Use the approved Electron Packager and operating-system archive/signature tools
to create development distribution files with checksums and a dependency
inventory. A requested signed build must fail if its signing inputs are absent;
it must never silently produce an unsigned release. Signing and notarization
need owner-provided release infrastructure. There are no signing identities on
the current Mac. No Windows/Linux user desktop is available through this host.
CI remains package and host-lifecycle evidence, not native client qualification.

Desktop builds install the frozen production lockfile into an isolated hoisted
dependency tree. Legacy deploy resolved different adapter versions and Packager's
extra-resource copy produced absolute links back to the build directory. Copy
gateway resources with preserved links before signing. Refuse external links,
bind distribution records to the verified package inventory, and test extracted
archives and startup with the original build unavailable. Mac development output
is DMG, Windows is ZIP and Linux is tar.gz. These are development distribution
files, not signed production installers or an automatic update channel.

The host verifies the complete gateway source digest, app/core/host versions,
platform, architecture and private protocol before startup. The worker handshake
must report the approved Node runtime. Platform signatures cover binaries in a
signed build; the source digest and unsigned checksum alone do not establish
publisher authenticity. Mac login startup becomes available only after local
signature, Gatekeeper and stapled-notarization checks succeed.

Engine updates require trusted, compatible artifacts and must not open newer
state with an older engine. Finish integrity and compatibility checks using the
existing runtime and crypto primitives. Keep unavailable engine versions and
unconfigured update channels explicit; never execute an arbitrary downloaded
program or treat an npm CLI release as a desktop update.

Codex and Hermes setup must preserve unrelated configuration, comments and user
edits. ADR 0067 records approval for smol-toml 1.8.0 and yaml 2.9.0 in the
desktop host, outside the CLI production dependency graph. It also records
production metadata-only logging, seven-day retention, a 1 GiB app log cap and
a separate Clear logs control. Development body logging remains as approved.

Native registration/notification and agent-conversation tests require an unlocked
Mac. Use isolated app instances and disposable test identities. A result in a
worker log or provider history does not prove visible app delivery. Keep each
external prerequisite and any failed test in the work plan.
