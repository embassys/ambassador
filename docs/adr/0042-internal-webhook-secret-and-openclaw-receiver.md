# 0042 Internal webhook secret and native OpenClaw hooks

Status: accepted

Date: 2026-09-03

Updated: 2026-09-03

## Problem

Webhook registration previously asked the agent for an environment-variable
name. The owner then had to generate a value, place it in Ambassador's process
environment, keep that process environment stable across restarts, and
configure the receiver separately. The model could not safely handle the raw
secret, so it could not complete or clearly explain that setup.

Ambassador 0.2.10 addressed OpenClaw webhook delivery with a custom plugin. Its
installation, capability approval, secret-store reference, plugin
configuration, and restart sequence made setup much heavier than OpenClaw's
built-in webhook support requires.

## Decision

Ambassador owns one webhook secret for its one persisted delivery profile. The
public command is:

```text
ambassador webhook-secret
```

The command accepts no options. It creates 24 random bytes when no secret
exists, encodes them as 48 lowercase hexadecimal characters, stores the value
encrypted, and writes the value to standard output. Repeated calls return the
same value. This explicit command is the only Ambassador interface that
reveals it; normal startup, MCP, errors, logs, and support evidence do not.

The encrypted value and its independently generated wrapping material use
`webhook-secret.json` and `webhook-secret.key` in Ambassador's owner-only state
directory. They use the same AES-256-GCM, scrypt, atomic-file, ownership,
POSIX-mode, and Windows-DACL controls as the central credential, with a
different key file and authenticated-data scope. Neither file is the central
credential or shares its wrapping material.

`ambassador webhook-secret` does not take the foreground process lock. It may
run while `ambassador start` is active because it touches only the dedicated
secret pair. It never rotates or replaces an existing value.

Webhook registration becomes staged:

1. A dual-mode profile still asks direct versus webhook, with direct first.
2. Selecting webhook returns `input_required` with the exact
   `ambassador webhook-secret` command and asks the owner to configure the
   displayed value in the receiver.
3. The follow-up supplies only `delivery.mode` and `delivery.url`.
4. Ambassador refuses central registration until the URL validates and its
   encrypted webhook secret exists.

The raw secret and a secret selector never enter MCP. The persisted webhook
profile contains only version, mode, matched agent kind, and canonical URL.
Profiles from the superseded `secret_env` format fail closed; there is no
credential or profile migration. Direct profiles are unchanged.

Each webhook-capable registry entry fixes its receiver contract. Hermes keeps
the complete canonical message body with bearer and HMAC V2 authentication.
OpenClaw uses its built-in `POST /hooks/agent` endpoint. Ambassador sends the
generated bearer secret, the central message ID as the idempotency key, and a
native agent body containing fixed untrusted-input instructions plus the
complete central message. The body fixes `name: "Embassys Ambassador"`,
`agentId: "main"`, `sessionMode: "isolated"`, and `deliver: false`.

OpenClaw's native endpoint does not accept SecretRef values for `hooks.token`.
The owner pastes the generated value into OpenClaw's owner-only configuration.
Using `openclaw config patch --stdin` keeps the value out of command arguments
and shell history. Ambassador does not install a plugin, modify OpenClaw
configuration, select a model, or expose the secret to the model.

The OpenClaw request omits Ambassador's HMAC V2, timestamp, and request-ID
headers because the native endpoint supports bearer authentication and its own
idempotency handling. The request must fit OpenClaw's 256 KiB body limit.
Hermes retains the existing 512 KiB canonical-body limit.

An OpenClaw `200` with a run ID proves session and global placement admission,
not model completion. Ambassador records that admission before acknowledging
central. Qualification continues until the model calls the required Ambassador
MCP tool and the requester receives the correlated response.

## Consequences

- The owner runs one Ambassador secret command and pastes one OpenClaw
  configuration block.
- Restart no longer depends on recreating Ambassador's process environment.
- The receiver still needs one deliberate copy of the value because the two
  local processes do not share a credential store.
- OpenClaw webhook setup needs no plugin, plugin capability approval, or plugin
  secret-store reference.
- Hermes keeps its exact-body HMAC V2 receiver contract.
- A webhook `2xx` remains a custody boundary, not proof that the later model
  turn or MCP call succeeded. Qualification waits for the correlated central
  result.
- Removing `webhook-secret.json`, `webhook-secret.key`, and the delivery
  profile is the local development reset. There is no server-side reset.

## Alternatives

- **Keep the environment-variable selector.** Rejected because it made routine
  setup multi-step and tied restart to shell or service-manager state.
- **Pass the secret through MCP.** Rejected because it would put a credential
  in model context and tool transcripts.
- **Configure provider state automatically.** Rejected because Ambassador does
  not own or mutate provider configuration. The owner copies the one value
  across the process boundary.
- **Keep the OpenClaw plugin.** Rejected because OpenClaw already has the
  required authenticated agent ingress and the plugin made installation harder.
- **Remove authentication on loopback.** Rejected because any same-user process
  could then start an OpenClaw model turn through the hook.
- **Rotate on every command.** Rejected because an uncoordinated change would
  immediately break the receiver.

## Approval

On 2026-09-03, the user approved an Ambassador command that creates, stores,
and displays the webhook secret, removal of `secret_env` from MCP, a guided
follow-up after webhook selection, implementation for Hermes and OpenClaw, and
an OpenClaw receiver followed by real live-central qualification.

Later that day, the user rejected the custom OpenClaw plugin experience and
approved the built-in `/hooks/agent` path instead. The user asked Ambassador
not to configure OpenClaw. The accepted experience is one manual OpenClaw
configuration block using the Ambassador-generated secret, followed by an
OpenClaw restart.
