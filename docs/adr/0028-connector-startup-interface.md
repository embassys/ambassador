# 0028 Connector startup interface

Status: superseded by ADR 0038; historical reference only

Date: 2026-08-30

## Problem

ADR 0024 accepts a separate foreground connector for one gateway and one
provider runtime. It does not choose the connector executable, startup
arguments, working-directory input, or local policy input. Those choices must
be fixed before connector tests or production code can define a public CLI.

The startup interface must give the local user enough authority to select a
loopback port, token source, working directory, and bounded policy. It must not
let a remote A2A message choose a provider, model, session, tool, MCP server,
sandbox, endpoint, directory, or credential.

## Decision

Build one shared provider-neutral connector foundation with three thin,
provider-specific foreground entrypoints. The entrypoint fixes the provider
kind. The gateway remains unaware of that choice and keeps its existing
two-option CLI.

The public command template is:

```text
a2a-<provider>-connector start \
  --webhook-port=<1024..65535> \
  --webhook-token-env=<environment-variable> \
  --working-directory=<canonical-absolute-path> \
  --policy=<read-only|workspace-write>
```

`start` accepts exactly those four required options, each exactly once and
only in `--name=value` form. It rejects split options, positionals, duplicate
options, missing options, empty values, and unknown options before resolving a
secret, opening connector state, binding a listener, contacting the gateway,
or starting a provider process. There is no optional verbose or configuration
flag.

ADR 0031 defines the package and binary names.

## Option contract

### Webhook port

`--webhook-port` is an ASCII decimal integer from `1024` through `65535`,
excluding `8787`, which the fixed gateway MCP listener already owns. Signs,
whitespace, leading zeroes, fractions, exponents, and non-ASCII digits are
invalid. The connector binds only:

```text
http://127.0.0.1:<webhook-port>/webhook
```

The host is fixed to the literal IPv4 loopback address and the path is fixed
to `/webhook`. The option does not accept a hostname, IP address, URL, path,
scheme, query, fragment, or interface name. The user supplies the resulting
URL as the gateway's existing `--webhook-url` value. This ADR does not change
the gateway CLI.

### Webhook token source

`--webhook-token-env` accepts an environment-variable name matching
`[A-Za-z_][A-Za-z0-9_]*`. The connector resolves that variable after it owns
its scoped singleton. The value must be exactly 48 lowercase hexadecimal
characters, representing 192 random bits. A missing, empty, malformed, or
line-breaking value fails startup.

The connector uses that same exact secret for both local relationships:

- it authenticates the incoming gateway wake through its bearer and HMAC V2
  checks; and
- it sends `Authorization: Bearer <secret>` on every request to the gateway's
  local MCP endpoint.

The value never enters command arguments, readiness output, fixed errors,
connector state, diagnostics, or a provider child process. This local secret
is not the central credential and is not a provider credential.

### Working directory

`--working-directory` must name an existing local directory by an absolute
platform path. Startup calls `fs.realpath.native`, verifies the result is a
directory, and rejects symbolic links, junctions, reparse points, network
shares, device paths, missing targets, and a spelling that resolves through a
different directory entry. The connector pins the resolved directory for the
life of the process. Remote wake or message data cannot change it.

On POSIX, canonical bytes are the exact UTF-8 bytes returned by
`fs.realpath.native`, with `/` separators and no trailing separator except for
root. The absolute normalized input must equal that returned path byte for
byte. On Windows, only a drive-letter path is accepted. Strip a `\\?\` prefix,
use `\` separators, uppercase the drive letter, remove trailing separators
except at the drive root, and compare normalized input with the normalized
real path using ordinal case-insensitive comparison. Persisted scope and AAD
use the exact UTF-8 bytes of the normalized real path with its on-disk casing.
Inputs that are not valid Unicode scalar strings fail. These rules, not the
caller's original spelling, supply the bytes used by ADR 0029.

The connector may pass the directory transiently as the provider process
working directory after the provider-specific contract is approved. It does
not persist or print the path. ADR 0029 defines the content-free binding to the
canonical directory without storing the path in plaintext.

### Local policy

`--policy` accepts only `read-only` or `workspace-write`. The option is
required, so startup never grants an implicit default authority.

- `read-only` prevents model and tool writes to the selected workspace.
- `workspace-write` permits model and tool writes only inside the selected
  workspace.

These values govern project and tool authority, not the provider runtime's own
operation. A later provider ADR may allow that provider to write only its
exact approved credential, session-history, and cache directories outside the
workspace. Those paths, retention behavior, and deletion controls must be
provider-owned and disclosed. They cannot be supplied by the sender or widened
by the adapter. Any other out-of-workspace write remains forbidden.

Neither value selects unrestricted execution, bypasses provider approvals,
enables a network policy, grants tools, or changes MCP configuration. Each
provider-specific ADR must define and test the exact mapping to that
provider's sandbox and approval controls. If the selected provider cannot
enforce the requested policy, its connector must fail closed instead of
substituting a broader mode.

The local user fixes the policy at process startup. Remote content cannot
change it or supply another policy-shaped field.

## Fixed local relationships

The gateway MCP endpoint is always:

```text
http://127.0.0.1:8787/mcp
```

The connector accepts no CLI option, environment override, configuration
field, discovered value, or remote field for that endpoint. It retrieves A2A
content and performs delivery-control operations through this authenticated
endpoint only.

The command has no option or environment input for:

- a literal webhook token;
- a webhook host, path, or full listener URL;
- a gateway or central endpoint;
- a working directory or policy through the environment;
- a provider, provider executable, model, session, thread, or turn ID;
- a system prompt, tool list, MCP server, sandbox implementation, or approval
  bypass;
- a state directory or general configuration file; or
- runtime discovery, provider installation, OS service management, or gateway
  setup.

Provider installation, authentication, invocation, versioning, and protocol
remain provider-specific decisions. The connector does not discover, install,
sign in to, or rewrite configuration for Codex, Claude Code, Gemini CLI, or
the gateway.

### Provider child environment

The connector builds a new child environment from an allowlist; it never
passes the inherited environment wholesale. On POSIX the common allowlist is
`HOME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`, and `TZ`. macOS
also permits `__CF_USER_TEXT_ENCODING`. On Windows it is `SystemRoot`,
`WINDIR`, `ComSpec`, `PATHEXT`, `PATH`, `TEMP`, `TMP`, `USERPROFILE`,
`LOCALAPPDATA`, `APPDATA`, `PROGRAMDATA`, and `LANG`. Missing optional values
stay missing.

The environment variable named by `--webhook-token-env` is removed even if its
name appears in that allowlist. Names beginning `A2A_`, plus names containing
`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `PRIVATE_KEY`, or
`CREDENTIAL` under ASCII case-insensitive comparison, are always removed.
This explicitly excludes provider API-key environment authentication from the
first connector release. Provider authentication must come from the exact
provider-owned storage approved by its provider ADR.

An adapter ADR may add a non-credential environment name only when it records
the purpose, accepted value grammar, inheritance risk, and tests. No adapter
may add a credential-shaped name, `NODE_OPTIONS`, `NODE_PATH`, loader or
dynamic-library injection variable, shell startup variable, sender-controlled
name, or connector secret. The provider executable path and arguments remain
fixed by that adapter ADR, not by `PATH` lookup after message receipt.

## Scope, singleton, and state handling

The connector scope is the provider kind fixed by the entrypoint plus the
canonical working directory. Each provider entrypoint has one fixed local
state location and one provider-wide singleton. The state cryptographically
binds that provider location to one canonical working directory. Running the
same provider against another directory therefore requires the explicit
whole-provider retirement command below; startup never creates a second hidden
store or selects state by a sender-controlled value. ADR 0029 proposes the
storage, locking, scope-binding, access-control, and cryptographic mechanisms.

Startup follows this authority order:

1. Parse and validate the exact command shape and non-secret option syntax.
2. Resolve and validate the canonical existing working directory.
3. Acquire the provider entrypoint's fixed singleton.
4. Resolve and validate the webhook token.
5. Open and validate only state bound to the same scope.
6. Bind the fixed loopback webhook endpoint.
7. Print the readiness line and remain in the foreground.

A scope mismatch, unreadable scoped state, or state from another provider or
working directory fails before webhook acceptance, gateway MCP access, or
provider execution. Startup never adopts, rewrites, moves, resets, or deletes
that state automatically. Changing a command option cannot be used as an
implicit recovery path.

### Explicit whole-provider retirement

The only proposed administrative command is:

```text
a2a-<provider>-connector retire-state \
  --confirm=retire-all-correlation
```

`retire-state` accepts that one exact option and value. It accepts no working
directory, token, state path, provider selector, wildcard, or force option.
The provider-specific entrypoint fixes the one state location it may touch.

The command validates its exact shape and resolves the fixed current-user
state root. If the connector and provider directories or owner database do not
yet exist, it creates only those exact components with ADR 0029's final
protections. It otherwise validates them without replacement. It acquires the
provider-wide singleton and verifies that every path from the state root to the
provider directory is the expected protected directory and not a symbolic link
or reparse point. Before unlinking anything, it closes the correlation
database, preflights ADR 0029's literal artifact allowlist, revalidates each
path and leaf, and durably publishes the content-free `retired.v1` tombstone
through ADR 0029's crash-resumable sequence. Only then may it unlink allowlisted
correlation artifacts. It keeps the singleton guard as the coordination point.
An unexpected path, leaf, link, owner, permission, or DACL refuses the
operation before the tombstone or a deletion. It never follows a link, expands
a glob, or accepts a caller-supplied deletion path.

This operation intentionally permits retirement when the correlation database
is corrupt or the original webhook token or working directory is unavailable,
but only after the owner database, protected path chain, and singleton validate.
Owner-database corruption refuses retirement and changes nothing. The command
therefore cannot prove whether provider work or an A2A message was still open. The
tombstone permanently blocks `start` for this provider location, so a later
central redelivery cannot appear to be new work and cannot start a second
provider turn. The tombstone is never removed and this location is never
reused. A future separately approved design may allocate a different versioned
provider location only after it proves the paired gateway has a newly enrolled
central identity while preserving the old marker. No such operation exists in
the first release.

The fixed confirmation means the local user accepts that future turns no
longer resume and unacknowledged central work needs manual handling. The
command does not delete gateway state, provider credentials, provider-native
session history, project files, or central data. Filesystem deletion is not a
secure-erasure claim, especially on journaled or solid-state storage.

There is no partial conversation deletion, repair, migration, import, status,
background service, or automatic reset command in the first release.

Successful retirement is idempotent. If `retired.v1` already exists and is the
exact valid tombstone, the command completes any remaining allowlisted
correlation-file deletion and returns exit `0`. It writes exactly `Connector
correlation state retired.` to stdout. Before marker publication, a refused
preflight writes only `connector_state_retire_refused`, exits `7`, writes no
success stdout, and changes nothing.

Cleanup after tombstone publication is not atomic. An OS failure may leave a
content-free partial-retirement state containing only the tombstone and a
subset of allowlisted correlation files. `start` always refuses that state.
Repeating `retire-state` revalidates the allowlist and resumes unlinking; it
never removes or rolls back the tombstone. A deletion or durability failure
after marker publication also writes only `connector_state_retire_refused`,
exits `7`, writes no success stdout, preserves the marker, and may preserve a
subset of the allowlisted correlation files.

## Readiness and foreground lifecycle

After the singleton, token, state scope, and listener are ready, the connector
prints exactly one readiness line to stdout:

```text
Connector webhook: http://127.0.0.1:<webhook-port>/webhook
```

It prints nothing before readiness and does not print the provider kind,
working directory, environment-variable name, token, state path, or provider
state. A gateway connection is not a readiness prerequisite because the
connector may need to listen before the gateway starts.

The connector remains in the foreground until interrupted. On `SIGINT` or
`SIGTERM`, it immediately stops admitting wakes and closes idle listener
sockets. Within 1 second it closes the listener and cancels in-flight gateway
MCP requests. It requests cancellation of at most two active provider turns in
parallel, applies ADR 0030's 10-second provider grace, then spends at most 3
seconds on the adapter's approved containment cleanup. The final 1 second
closes state and releases the singleton. The total shutdown deadline is 15
seconds.

If a provider or descendant remains after its approved cleanup, the connector
leaves the affected message open, writes only `connector_shutdown_incomplete`,
and exits `1`. That provider and platform cannot qualify until its adapter
passes the hard-crash and orphan tests in ADR 0030. Native service
installation, detached mode, daemonization, background start, `stop`, and
`restart` are outside this interface.

## Fixed startup errors and exits

Startup errors write one fixed code to stderr and never include an option
value, environment-variable value or name, path, URL, header, body, provider
output, or state contents.

| Exit | Fixed error code | Category |
| ---: | --- | --- |
| `0` | none | Clean foreground shutdown |
| `1` | `connector_internal_error` | Unexpected internal startup failure |
| `2` | `invalid_connector_arguments` | Command, option, port, directory, or policy is invalid |
| `4` | `webhook_token_unavailable` | Token environment lookup or token validation failed |
| `7` | `connector_already_running` | The provider entrypoint singleton is owned |
| `7` | `connector_state_unavailable` | Scoped state cannot be opened or validated |
| `7` | `connector_scope_mismatch` | Existing state does not authenticate under the syntactically valid token, provider, and directory scope |
| `7` | `connector_state_retired` | The provider location has a retirement tombstone and cannot start |
| `7` | `connector_state_retire_refused` | Whole-provider retirement cannot validate its exact protected target or allowlist, or cannot finish durable cleanup after marker publication |
| `8` | `connector_listener_unavailable` | The fixed loopback endpoint cannot bind |
| `1` | `connector_message_blocked` | Valid durable state records a permanent message stop and permits no automatic request |
| `1` | `connector_shutdown_incomplete` | Bounded shutdown could not prove approved provider containment cleanup |

The stderr form is exactly `a2a connector: <fixed_error_code>`. A normal error
does not echo the rejected value or distinguish a missing token variable from
a malformed token. Provider-turn errors and terminal outcomes are not startup
errors and remain part of ADR 0030's execution and approval-policy decisions.

`start` applies these mappings in order after argument and canonical-directory
validation: a missing or syntactically invalid token is
`webhook_token_unavailable`; invalid protected paths, owner state, or singleton
state use their exact table row; an exact marker is `connector_state_retired`;
a malformed marker is `connector_state_unavailable`; and a syntactically valid
token, provider, or canonical-directory scope-HMAC mismatch is
`connector_scope_mismatch`. Other schema, cryptographic-envelope, or database
failures are `connector_state_unavailable`. `retire-state` does not resolve the
token or working directory. After its arguments, protected paths, owner
database, and singleton validate, an exact marker resumes cleanup, a protected
exact-prefix partial marker resumes publication under ADR 0029, and every
other malformed marker is `connector_state_retire_refused`.

## Security consequences

Three provider-specific entrypoints keep provider choice outside gateway and
remote message data. A shared foundation can still enforce one startup parser,
scope model, token boundary, listener shape, and error contract.

Reusing the webhook token avoids another local credential, but compromise of
that token grants both wake submission and gateway MCP access. The token stays
out of argv and provider child state. The connector must remove it from any
allowlisted child environment before provider execution. The central token and
DPoP key stay in the gateway, while provider credentials stay in the provider
runtime.

The working directory appears in the local process arguments. It is not a
secret, but it can reveal user or project names through process inspection.
The connector therefore does not copy it into state, readiness output, normal
errors, or diagnostics. The later state design must bind scope without storing
the plaintext path.

Requiring the user to state `read-only` or `workspace-write` makes local
authority visible at launch. It does not by itself prove enforcement. Each
provider adapter must fail startup or execution when it cannot enforce the
requested policy without broadening it.

## Platform impact

The fixed IPv4 loopback address and port range are portable, but canonical
path comparison, singleton ownership, state access control, signal handling,
and provider policy enforcement differ by operating system. This record and
the later provider ADRs must define and test those mechanisms before claiming
a platform. This accepted record makes no Windows, macOS, Linux, package, or
packed installation claim.

The connector's supported platforms cannot exceed both the gateway's
qualified platforms and the selected provider runtime's qualified platforms.

## Alternatives

- One executable with `--provider=<kind>`. This shortens the package list but
  adds a general provider selector to the public runtime interface. Thin
  provider-specific entrypoints keep that choice local and fixed before remote
  content arrives.
- A JSON or YAML configuration file. This can group options, but it creates a
  durable authority source, needs its own permissions and schema, and can
  retain stale paths or secrets. The proposed first interface has no general
  configuration.
- Endpoint or working-directory environment variables. These hide execution
  authority from the command being reviewed and make inherited environments
  more dangerous. Only the secret token uses an environment reference.
- A literal token option. This exposes the shared local bearer in process
  listings and shell history.
- A full listener URL. Accepting only a port prevents alternate hosts, paths,
  schemes, credentials, queries, and fragments.
- One fixed connector port. A required port makes local conflicts explicit and
  lets the user supply the matching URL to the unchanged gateway CLI.
- An omitted policy with a default. Requiring the option prevents startup from
  silently choosing write authority.
- Runtime discovery, automatic installation, or service management. These
  expand local authority and conflict with the accepted foreground companion
  boundary.

## Costs

The four-option command is longer than a config-based startup. Three thin
entrypoints add package and release bookkeeping. The fixed gateway endpoint
also preserves the one-pair model rather than supporting several gateways in
one user session.

Canonical path rejection can surprise users who launch through a symlink.
That cost is deliberate because the same visible directory spelling should
not attach one provider session mapping to another filesystem location.

Whole-provider retirement is deliberately coarse. It removes readable local
correlation while leaving a permanent fail-closed tombstone, rather than
pretending that partial correlation can be repaired safely. The confirmation
is non-interactive and scriptable, so setup documentation must explain its
irreversible continuity and manual central-handling consequences before
showing the command.

## Approval

Approved by the user on 2026-08-30. This approval does not select a provider
executable or SDK version, authorize public package publication, or make a
provider and platform support claim.
