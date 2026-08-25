# A2A gateway

Read this before working on the project.

## What we are building

The gateway is one per-user daemon with two responsibilities. Its notification relay durably receives opaque IDs and wakes local AI agents. Its local MCP proxy authenticates independently running agents, holds their central JWT references, and injects those JWTs into central MCP calls.

This combined-process design is an intentional short- and medium-term choice. It matches the available central API, which identifies each message stream through an agent JWT. We may split the responsibilities after the controller provides an installation-scoped notification API and restricted gateway credentials.

The user's machine remains closed to inbound internet traffic. The local MCP endpoint listens only on loopback and requires caller authentication.

## Rules we will not bend

- The notification path receives opaque IDs only. It rejects task text, responses, permissions, grants, tool arguments, and MCP payloads.
- The combined process may handle MCP requests and responses transiently, but it never writes them to configuration, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- A local MCP caller is authenticated and mapped to one fixed binding. Request data cannot select another binding or central JWT.
- Central JWT values come from approved secret references. They never appear in configuration, URLs, MCP tool arguments or results, durable state, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- Once the gateway acknowledges a notification, that notification must survive a crash or restart.
- A wake retry uses the same `delivery_id`, so the runtime can detect a duplicate wake.
- One gateway can route deliveries and MCP calls for several local agents.
- Runtime-specific wake code stays behind adapters.
- The gateway does not run a model or hold model-provider credentials.
- No gateway interface accepts inbound internet traffic.

## How it fits together

```text
Central controller and MCP API
  authentication, authorization, delivery queue, MCP tools
          ^                              |
          | authenticated MCP calls      | authenticated long poll, IDs only
          |                              v
Combined local gateway process
  local MCP proxy              notification relay
  JWT injection                durable journal and retries
          ^                              |
          | authenticated loopback MCP   | authenticated local wake, delivery ID
          |                              v
Local agent runtime <-------------- wake adapter
  independent process
```

## Delivery and tool flow

1. A configured binding associates one central agent identity and JWT reference, an authenticated local caller mapping, and one wake adapter.
2. The gateway long-polls that binding's central message stream and accepts an opaque message ID only.
3. The relay validates and records the ID before acknowledging it.
4. The relay wakes the configured runtime with a fixed instruction and the same delivery ID.
5. The independent agent calls the gateway's loopback MCP endpoint without supplying its central JWT.
6. The proxy authenticates the local caller, selects the caller's fixed binding, injects that binding's central JWT, and forwards the tool call.
7. MCP request and response bodies pass through memory but are not persisted or logged.
8. The relay reports wake acceptance or failure when the controller supports that operation.

## Data boundary

The durable relay may store notification, delivery, and binding IDs. It may also store retry state, timestamps, local session mappings, and pending acknowledgements or wake reports.

The combined process may transiently process MCP tool arguments and responses. It must not store prompts, attachments, agent responses, results, permission details, grants, central JWT values, or MCP request and response bodies in files, SQLite, diagnostics, metrics, logs, temporary spools, crash artifacts, or support bundles.

Notification parsing and MCP proxying remain separate code paths. Content accepted by the MCP proxy must never enter the relay state machine or durable outbox.

## Who owns what

| Component | Responsibility |
| --- | --- |
| Central controller and MCP API | Agent authentication, authorization, message assignment, task state, grants, and MCP tools |
| Gateway notification relay | ID receipt, durable acknowledgement, local binding lookup, wake retries, and wake reports |
| Gateway local MCP proxy | Local caller authentication, fixed binding selection, approved tool exposure, central JWT injection, forwarding limits, and response return |
| Wake adapter | Runtime authentication, wake request translation, health checks, and idempotency keys |
| Local runtime | Agent sessions and authenticated calls to the gateway's loopback MCP endpoint |

## Short-term release target

- One headless per-user process plus CLI.
- ID-only durable notification relay.
- Authenticated loopback MCP proxy in the same process.
- Per-binding central JWT references, with no JWT tool arguments.
- macOS, Linux, and Windows service support.
- Generic authenticated webhook adapter.
- Hermes and OpenClaw presets after their wake paths and duplicate handling pass tests.
- Model-free fake controller, fake central MCP service, and fake runtime for local and CI testing.

## Not in the short-term release

- Implementing or hosting the central MCP service.
- Durable storage of task, result, permission, grant, or MCP payload data.
- An MCP or notification listener exposed beyond loopback.
- Public A2A server or Agent Card.
- ACP and headless CLI adapters.
- Grok Bot and hosted-agent connectors.
- Desktop GUI and automatic self-update.

## Open constraints

- Select and approve the local MCP transport and caller-authentication contract.
- Select the proxied tool catalog and define central JWT enrollment, refresh, revocation, and reissue without returning JWTs through local tools.
- Redesign configuration and CLI setup for per-binding central JWT references and local MCP identities.
- Confirm global message-ID uniqueness across JWT-scoped poll streams. Otherwise approve one namespacing design for journal keys, acknowledgement mapping, and runtime wake idempotency keys before integration.
- Add controller redelivery, idempotent persistence acknowledgement, expiry metadata, and wake reporting around the available `poll_messages` API.
- Add OS credential-vault support before public beta.
- Prove cross-binding isolation and prove that MCP content never reaches durable state or logs.
- Prove duplicate wake behavior in each supported runtime.
