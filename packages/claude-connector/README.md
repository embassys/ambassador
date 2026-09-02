# A2A Claude connector

This private package contains the provider-neutral connector foundation and the
Claude command entrypoint. ADR 0035 selects a separately installed official
Claude Code headless CLI at exactly version `2.1.251`. The connector adds no
Claude SDK, provider package, installer, updater, or authentication code. CL02
and CL03 implement and test the fake protocol and adapter. CL04 supplies an
offline manual runner, but no real authenticated Claude run has succeeded.
The package has no provider or platform support claim and is not approved for
publication.

Its central-facing workflow assumes conversation and reply routes that the
current server does not have. Do not run it against the live service until the
connector is redesigned around permission and action messages.

The foreground command is:

```text
a2a-claude-connector start --webhook-port=<port> --webhook-token-env=<name> --working-directory=<absolute-directory> --policy=<read-only|workspace-write>
```

The gateway must be running on `127.0.0.1:8787`. Put its 48-character
lowercase hexadecimal webhook token in the named environment variable. The
connector accepts authenticated webhook wakes only on the selected loopback
port.

Provider-neutral setup, policy, history, retention, and retirement guidance is
in [connector setup and retention](../../docs/connector-setup-and-retention.md).

The selected adapter starts one packaged Node lifetime monitor
per turn with the monitor detached as the exact connector-known POSIX process
group leader. The monitor starts one `claude` child into that same group.
Prompt stdin and provider output pass through the monitor. A separate
zero-byte owner pipe and bounded content-free command and status pipes remain
open after prompt EOF. Normal completion, forced containment, and owner death
all seal the same known group with bounded TERM then KILL. The connector emits
no terminal event until it has reaped its direct monitor and proved that exact
group empty. There is no normal monitor release or monitor-supplied emptiness
claim.

The adapter sends A2A input only as a structured stream-JSON record on
stdin, uses a caller-generated or exactly resumed session ID, selects restricted
safe mode with `dontAsk`, and grants no provider approval. The monitor uses the
already approved connector Node runtime and adds no dependency or provider
executable. A provider crash after input is uncertain because Claude Code
2.1.251 has no approved exact-turn result lookup.

The connector never installs Claude Code, signs in, copies a provider
credential, or reads provider-owned history. Claude keeps its own
content-bearing session history under the user's normal account and retention
settings. Connector state retirement does not remove that history or log the
user out.

Linux x64, macOS arm64, and macOS x64 are qualification candidates only.
Support requires the later CL04 manual run with an explicitly available
authenticated disposable environment. Windows is unsupported under ADR 0033.
Installations with administrator-managed executable Claude hooks or commands
are outside ADR 0035's qualified contract because safe mode cannot override
them.

To retire all Claude correlation state for the current account, use the
separate confirmed command described in the project architecture. Retirement
is permanent for the version 1 state location.
