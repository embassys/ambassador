# 0042 Internal webhook secret and OpenClaw receiver

Status: accepted

Date: 2026-09-03

## Problem

Webhook registration previously asked the agent for an environment-variable
name. The owner then had to generate a value, place it in Ambassador's process
environment, keep that process environment stable across restarts, and
configure the receiver separately. The model could not safely handle the raw
secret, so it could not complete or clearly explain that setup.

OpenClaw also had no committed receiver for Ambassador's canonical webhook.
Its generic mapping layer exposes parsed payloads, not the exact request bytes
needed to verify Ambassador's HMAC V2 contract.

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

The package also ships `integrations/openclaw-ambassador`, an OpenClaw plugin
that registers the exact `/embassys/ambassador` route. The receiver:

- reads at most 512 KiB;
- verifies the bearer, HMAC V2 signature over the exact bytes, five-minute
  timestamp window, idempotency key, request ID, and canonical outer message;
- deduplicates accepted message IDs in bounded memory;
- returns `202` only after a bounded plugin-service queue has accepted the
  message, then starts a durable OpenClaw embedded-agent turn outside the
  completed HTTP request's work-admission scope; and
- passes the complete message in a fixed untrusted-input prompt so the model
  can use its normally configured Ambassador MCP server.

The service queue is memory-only and serial. It is bounded to 64 pending model
turns; a full or stopped service returns `503` before accepting custody. This
preserves the architecture's no-message-body-persistence rule. OpenClaw's
external-plugin runtime does not make its durable ingress queue available to an
unofficial local-path install, so the package does not bypass that trust check
or write its own body spool.

Starting the embedded turn as a detached promise directly in the HTTP handler
does not work. OpenClaw releases the handler's root work-admission lease when
the handler returns; the detached continuation inherits that released lease
and fails before model execution with `GatewayDrainingError`. The
plugin-service handoff is created outside that request context and avoids the
false drain classification. Logs retain only a bounded failure category, never
the underlying error text or provider output.

The plugin resolves its secret through OpenClaw's secret-input API. Public
setup uses OpenClaw's encrypted secret store, not a plaintext plugin value.
OpenClaw must explicitly accept the plugin's HTTP-route capability during
installation. Ambassador does not install or configure OpenClaw.

Hermes continues to use its native generic webhook receiver. The owner places
the displayed Ambassador secret in Hermes's owner-only webhook configuration;
Hermes verifies both bearer and HMAC V2 before starting its model turn.

## Consequences

- The owner runs one memorable setup command instead of inventing an
  Ambassador environment variable.
- Restart no longer depends on recreating Ambassador's process environment.
- The receiver still needs one deliberate copy of the value because the two
  local processes do not share a credential store.
- OpenClaw webhook delivery has a concrete, package-shipped receiver rather
  than an undocumented mapping assumption.
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
- **Use OpenClaw's parsed generic mapping.** Rejected because HMAC V2
  authenticates exact bytes before parsing.
- **Rotate on every command.** Rejected because an uncoordinated change would
  immediately break the receiver.

## Approval

On 2026-09-03, the user approved an Ambassador command that creates, stores,
and displays the webhook secret, removal of `secret_env` from MCP, a guided
follow-up after webhook selection, implementation for Hermes and OpenClaw, and
an OpenClaw receiver followed by real live-central qualification.
