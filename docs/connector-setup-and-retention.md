# Connector setup and retention

Status: local provider reference; current central integration redesign pending

This guide describes the useful local connector boundaries that remain after
ADR 0037. It is not a support or release claim. No Codex, Claude, or Gemini
connector has completed a real authenticated qualification run.

The implemented connector execution flow assumes central conversation and
reply routes that the current server does not provide. Do not use the setup
below against the live service until the connector is redesigned around
permission and action messages after I05. The published gateway `0.2.6` is
also unsupported against the current DPoP REST contract.

## Provider status

| Provider | Local status | Real qualification |
| --- | --- | --- |
| Codex | The `0.149.0` App Server adapter and fake protocol are implemented. CX04 supplies an offline manual runner. | Not run |
| Claude Code | The headless CLI `2.1.251` fake protocol and adapter are implemented. CL04 supplies an offline manual runner. | Not run |
| Gemini CLI | ADR 0036 rejects CLI `0.57.0` and the reviewed alternatives. No adapter is selected. | Blocked |

Users install and authenticate an approved provider runtime through that
provider's normal mechanism. The connector does not install, update, sign in
to, sign out of, or inspect provider credentials. CI uses only fake provider
interfaces and contains no provider credential or provider history.

## Process layout

Run one foreground gateway, one provider-specific foreground connector, and
one provider runtime for a deployment. The three connector binaries remain
separate:

```text
a2a-codex-connector
a2a-claude-connector
a2a-gemini-connector
```

There is no provider flag, runtime selector, installation discovery, binding,
or provider-specific gateway behavior. One connector owns one provider kind,
one canonical working directory, one encrypted correlation store, and one
provider-wide singleton.

The gateway CLI remains limited to:

```text
a2a-gateway start \
  --webhook-url=http://127.0.0.1:<connector-port>/webhook \
  --webhook-token-env=<environment-variable>
```

The connector CLI is:

```text
a2a-<provider>-connector start \
  --webhook-port=<1024..65535> \
  --webhook-token-env=<environment-variable> \
  --working-directory=<canonical-absolute-path> \
  --policy=<read-only|workspace-write>
```

Use only the exact `--name=value` form. The connector binds its webhook to
literal `127.0.0.1` and calls the gateway MCP endpoint at the fixed
`http://127.0.0.1:8787/mcp` address.

The named environment variable must contain the same 48-character lowercase
hexadecimal secret for both processes. Keep it out of shell history,
configuration files, command arguments, provider settings, and reports. The
connector removes the token and every credential-shaped environment variable
before it starts provider work.

The following example is illustrative only. It does not make the current
central or provider qualification gates pass:

```sh
# Have a secret manager inject A2A_CONNECTOR_WEBHOOK_TOKEN into this process.

a2a-codex-connector start \
  --webhook-port=8790 \
  --webhook-token-env=A2A_CONNECTOR_WEBHOOK_TOKEN \
  --working-directory=/absolute/canonical/workspace \
  --policy=read-only
```

In another terminal, with the same secret available only to the gateway:

```sh
# Have a secret manager inject the same token into this process.

a2a-gateway start \
  --webhook-url=http://127.0.0.1:8790/webhook \
  --webhook-token-env=A2A_CONNECTOR_WEBHOOK_TOKEN
```

The gateway owns the fixed live REST origin. The connector never receives a
central URL, token, or DPoP key. See the
[central REST contract inventory](central-server-implementation-spec.md).

## Working directory and policy

The working directory must already exist and must use its canonical absolute
spelling. The connector rejects links, aliases, network shares, scope changes,
and a directory that does not match existing encrypted state. Remote message
content cannot change the directory, provider, model, tool list, session,
sandbox, approval behavior, MCP configuration, or environment.

The required policy is a maximum:

- `read-only` permits no model or tool write to the workspace.
- `workspace-write` permits writes only inside the selected workspace.

An adapter may narrow the selected maximum. It may never widen it. Neither
policy gives the model or its tools unrestricted execution, unrestricted
network authority, an approval bypass, or automatic approval. A provider
runtime may still make its own API and authentication requests and write its
own credentials, history, and cache outside the workspace. If the provider
cannot enforce the requested maximum, the connector fails closed before
provider input.

The connector has no approval HTTP route, MCP tool, CLI command, terminal
prompt, file, socket, or environment control. It never grants a permission.
An adapter may preserve a provider-owned approval decision only when its ADR
fixes and tests that interface. Unsupported approval requests remain waiting
until the absolute deadline or fail closed according to the provider contract.

## Provider-owned history

Multi-turn continuity depends on provider-owned persistent history. Provider
history may contain prompts, replies, tool calls, tool inputs, tool results,
and permission details. It remains under the provider account's storage,
retention, and deletion controls.

The connector does not copy, index, archive, export, delete, or include that
history in fixtures or reports. It stores only encrypted opaque session and
turn identifiers when the selected interface supplies them. Users who delete
or expire provider history may lose resume or exact recovery. The connector
then fails closed and never creates a replacement conversation for an unknown
prior turn.

Codex exact-turn recovery is the narrow exception to the connector not reading
provider history. As fixed by ADR 0034, the adapter may call `thread/read` with
`includeTurns: true` and scan a bounded response for the exact stored turn. It
discards the response immediately and never persists or logs provider-history
content. No other provider-history search or inspection is permitted.

The current Codex and Claude contracts do not offer a no-history mode. They
must not be described as one-shot connectors. A future one-shot mode would
need a separate decision and could not claim multi-turn continuity.

## Connector state retention

Connector durability is separate from provider history and gateway state. It
contains only encrypted opaque conversation, message, provider-session, and
provider-turn identifiers, plus content-free lifecycle and bounded retry
timing. It never contains prompts, replies, tool data, approval details,
credentials, email addresses, verification codes, provider history, or a
plaintext working directory.

The first release retains unacknowledged, blocked, and uncertain message rows
indefinitely. It deletes a message row only after the exact central
acknowledgement is durable. Conversation mappings and closed tombstones remain
until whole-provider retirement. The store has a lifetime ceiling of 100,000
conversations and a 256 MiB database limit. The conversation ceiling refuses
only new conversations. The database-size bound refuses any write that cannot
complete within the limit. Neither case deletes existing mappings.

An uncertain conversation never starts another provider turn. A later message
for a blocked, uncertain, or closed conversation also starts no provider work.
Do not use retirement as recovery from an uncertain provider outcome.

## Permanent retirement

Stop the connector before retirement, then run the matching provider binary:

```text
a2a-<provider>-connector retire-state \
  --confirm=retire-all-correlation
```

This command accepts no path, provider selector, wildcard, force option, token,
or working directory. It writes a permanent `retired.v1` tombstone, removes
only the connector's allowlisted correlation artifacts, and makes future
`start` calls for that provider location fail closed. Interrupted cleanup is
resumable by repeating the exact command, but the tombstone is never removed.

Retirement does not delete or change:

- provider credentials or provider-owned history;
- project or workspace files;
- gateway credentials, notification state, or enrollment;
- central messages, identities, pairings, or retention; or
- another provider connector's state.

Any unacknowledged central work then requires manual handling, and future
turns cannot resume through the retired local mappings.

Filesystem deletion is not a secure-erasure claim. The command is a permanent
local correlation-state retirement, not a provider logout, history purge,
conversation reset, repair, or migration.

## Evidence still required

Linux x64, macOS arm64, and macOS x64 are candidate platforms. Windows is
unsupported under ADR 0033. A provider and platform pair gains support only
after its fake protocol, packed artifact, policy, cancellation, hard-crash
containment, recovery, history, and real authenticated qualification gates all
pass.

As of 2026-09-01:

- the provider-neutral fake connector chain is implemented;
- the Codex fake App Server adapter is implemented;
- the Claude fake and production adapters are implemented, and the CL04 manual runner is available;
- Gemini has no selected interface;
- no real provider qualification has succeeded;
- the gateway central client is being replaced with the live REST contract;
- the connector's central-facing flow needs redesign after that work;
- connector publishing and stable release remain unapproved.

The guide therefore remains a local reference, not an operable live setup.
Fake tests, an offline manual runner, or accepted process boundaries do not
replace current central and real-provider evidence.
