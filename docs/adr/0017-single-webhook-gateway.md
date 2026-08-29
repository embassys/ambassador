# 0017 Single-webhook gateway

Status: accepted

Date: 2026-08-25

Updated: 2026-08-29 for the accepted REST, DPoP, and lease-based next contract

## Problem

The earlier CLI and configuration model asked the gateway to discover or configure runtimes, manage bindings, and receive a central JWT before startup. The intended user flow is smaller. A user already has a local webhook URL and token. Central registration happens later through the gateway's local MCP interface.

## Decision

One gateway process owns one webhook target and, after enrollment, one central agent identity. It does not know the local runtime type or a configured local-runtime agent ID.

The normal command has exactly two required named options. ADR 0022 temporarily permits one additional `--verbose=true` option when the paired development endpoints are present:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The CLI accepts only the `--name=value` form for these options. The token option names an environment variable because literal secrets in command arguments leak through shell history and process listings.

`start` runs in the foreground until interrupted. It does not discover a runtime, create a binding, write general configuration, install an OS service, or modify another application's files. On successful startup it prints the stable local MCP endpoint:

```text
MCP endpoint: http://127.0.0.1:8787/mcp
```

The webhook URL must use the literal loopback address `127.0.0.1`. The webhook token must contain 192 random bits as 48 lowercase hexadecimal characters. The MCP listener binds only to `127.0.0.1`. It requires `Authorization: Bearer <webhook-token>` on every request. Reusing the webhook token avoids a second local credential without disclosing the local MCP bearer to a remote webhook recipient. Compromise of that token still grants both webhook wake and local MCP access; this tradeoff is accepted for the single-user local design.

The central API and MCP URLs are product constants, not user-facing CLI options. Until those constants are available, the `0.2.0` development release accepts `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` as a paired environment override. A development flow sets both. Remote values require HTTPS, while loopback development servers may use HTTP. The override does not change the two-option CLI or add general configuration.

## Shipped `0.2.6` enrollment

Before enrollment, the local MCP server exposes only the central-JWT-exempt bootstrap tools `register_agent`, `verify_email`, and `resend_verification`. The local bearer check still applies.

1. The agent calls `register_agent`; the gateway forwards it to the central MCP server.
2. The user receives an email code and gives it to the agent.
3. The agent calls `verify_email`; the gateway forwards it.
4. The gateway extracts the central JWT from the successful upstream result, persists it in the credential store, and replaces the result with a token-free confirmation.
5. The gateway replaces the bootstrap catalog with authenticated tools, emits an MCP tool-list change notification, and starts notification polling with that JWT.
6. Future local authenticated tool schemas omit `token`; the gateway injects it only into the transient upstream tool arguments required by the current central MCP server.

The gateway never returns a central JWT to the local MCP client. Registration email, display name, verification code, MCP arguments, and MCP results pass through memory only.

A first successful verification owns the gateway identity. A later verification cannot silently replace it. Credential reset and central token reissue remain future operations.

An upstream authentication failure stops polling and authenticated tools without deleting or replacing the stored credential.

## Shipped `0.2.6` notification and wake behavior

The gateway starts with the live central API: `GET /api/poll_messages?timeout=30` returns full queued messages and marks them delivered. The gateway treats an explicit HTTP `404` as an absent public route and switches for that process lifetime to the central MCP `poll_messages` tool with a 20-second timeout and transient JWT injection. No uncertain transport outcome, redirect, or other HTTP status triggers the fallback because REST may already have consumed a message. Both paths use the same bounded validation. Because a later poll cannot retrieve a delivered message, the gateway keeps the validated response in bounded process memory and serves it from its local `poll_messages` tool without another central request. The 4 MiB transport cap is followed by pre-parse limits of 100 JSON levels and 16,384 structural tokens. A valid inbox contains at most 256 messages and 512 KiB of normalized local result JSON. Central polling pauses while a body or volatile wake remains from that response. Message bodies never enter SQLite, files, logs, diagnostics, metrics, temporary files, crash artifacts, or support bundles.

After the fallback, retryable MCP connection and request failures remain on MCP. MCP authentication failure disables authenticated work. A redirect, malformed result, credential-bearing result, or oversized result stops the gateway rather than repeatedly issuing a consuming call after a deterministic contract failure.

Present message IDs are stored in the ID-only journal and drive webhook retry and accepted-wake redelivery until central `ack_message` confirms `{message_id, status: "acked"}`. Confirmation deletes the journal row so acknowledged traffic cannot accumulate durable state. Failed, uncertain, and mismatched acknowledgements leave the body available. ID-less messages are distinct observations: each receives a process-local wake key, is returned once through local `poll_messages`, and is neither durably deduplicated nor acknowledged. An early local poll does not cancel its pending webhook retry.

The live central interfaces have no operation that retrieves delivered but unacknowledged messages. A process stop or crash after either consuming poll therefore loses the in-memory body. On restart the gateway discards every wake row because no body can be recovered. This degraded recovery is accepted for the development release; production requires central redelivery or delivered-message retrieval.

The fixed wake body omits `agentId`, so a webhook owner chooses its default target. An ID-bearing wake varies only by its opaque message ID; an ID-less wake uses a generic fixed instruction and a process-local correlation key. Every request carries the configured bearer token and a generic HMAC V2 signature over the exact body, using the same token as its key and a current Unix timestamp. `Idempotency-Key` and `X-Request-ID` carry the message ID or volatile correlation key. The gateway sends all of these headers for every target; it does not select a runtime or authentication mode.

The gateway stores only message IDs and relay state durably. It never stores message bodies, task data, permissions, results, email addresses, verification codes, or plaintext central JWTs in SQLite, configuration, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.

The `0.2.1` through `0.2.6` packages retain the `0.2.0` loopback Hermes bridge for existing installations that still target port `8645`, but current setup sends signed wakes directly to Hermes. The compatibility file does not change the gateway process or add runtime selection.

The MCP endpoint requires its exact loopback `Host`, permits a missing `Origin` for non-browser clients, rejects any other supplied `Origin`, limits request and response sizes, applies deadlines, rejects redirects, and rechecks the bearer token on every request. MCP session IDs never act as authentication.

## Accepted next contract

The one-process, one-webhook, one-identity decision and exact public command do
not change. ADRs 0023, 0025, and 0026 supersede the shipped central enrollment,
authentication, credential, and delivery details as the implementation target.

Bootstrap remains available through the gateway's local authenticated MCP
interface, but the gateway owns those schemas and sends bounded central REST
requests to `/api/register`, `/api/verify_email`, and
`/api/resend_verification`. It does not forward bootstrap calls through central
MCP, probe an alternate registration route, or fall back after a failure.

Verification creates a P-256 key and uses a DPoP issuance proof. The gateway
intercepts the returned token and persists the token and key as the atomic
version 2 credential in ADRs 0019 and 0026. Every protected central REST and
MCP HTTP request uses `Authorization: DPoP` and a fresh proof. Central MCP tool
schemas and arguments contain no token.

Verification is the first credential source, not the only permitted token
response. Scheduled same-key reissue may replace a working credential under
the exact identity and key checks in ADR 0026. Email-control verification may
replace it with the same central identity and a new key after central revokes
the old tokens. A `401`, invalid token, proof failure, key failure, or ordinary
tool failure never triggers refresh or replacement.

The message target uses the fixed REST v2 lifecycle in ADR 0025. Central leases
the oldest bounded message batch for 60 seconds and retains each immutable body
until terminal outcome and acknowledgement. An expired unacknowledged lease
makes the same body eligible again. A restart clears stale local wake rows and
waits for central redelivery, so the shipped consuming-poll crash loss is no
longer the recovery target.

The gateway still keeps message bodies only in bounded memory and persists only
opaque IDs and relay state. It does not add runtime discovery, capability
negotiation, route probing, bindings, general configuration, service
management, or provider credentials.

This amendment accepts the client and server contract. It does not claim that
the production central service implements it. The test-only
[version 2 fixture profile](../v2-fixture-profile.md) supplies explicit
stand-ins for missing deployment facts; it does not define production URLs,
keys, proxy trust, or capacity.

## Removed behavior

The active design has no `setup`, `agent add`, `agent list`, `agent remove`, `agent test`, `stop`, `restart`, `status`, `doctor`, or `run` command. It has no binding IDs, runtime adapters, runtime presets, JSON configuration file, or native service definitions.

The published `0.1.0` package retains those behaviors. Replacement source deletes them after the new design passes the required tests rather than carrying compatibility code into the next release, because no released central integration depends on it.

The replacement uses new `a2a-gateway` state paths and ignores legacy `a2a-sidecar` configuration and journal files. It does not delete them automatically.

## Approval

The user approved the two-option, agent-agnostic startup and MCP enrollment flow on 2026-08-25. The same-day development release request approved the paired environment endpoint override without adding CLI options. The user also directed the project to delete obsolete ADRs instead of retaining them as superseded history. On 2026-08-26, the user approved runtime-agnostic bearer and HMAC V2 webhook authentication and the `0.2.1` patch release. On 2026-08-27, the user directed the gateway protocol to match the live consuming central API and requested follow-up releases, including a temporary MCP polling path while the public REST route is unavailable. On 2026-08-29, the user approved ADRs 0023, 0025, and 0026 as the next contract and allowed missing central deployment facts to be represented in test fixtures until central confirms them.
