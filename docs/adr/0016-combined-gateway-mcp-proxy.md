# 0016 Combined gateway and MCP proxy

Status: accepted

Date: 2026-08-25

Supersedes ADR `0003-controller-http-transport.md`, the single controller-token shape in ADR `0005-configuration.md`, and the installation-token assumption in ADR `0009-operating-defaults.md` for the short- and medium-term design. The rest of ADRs 0005 and 0009 remain under review.

## Problem

The available central API identifies an agent through its JWT. Its `poll_messages` operation and authenticated MCP tools therefore need the same central identity and credential. Splitting notification polling and MCP proxying into separate local processes would make both processes resolve the same identity and credential without removing that central API constraint.

Independent agent runtimes also need a local MCP endpoint that does not expose the central JWT as a tool argument.

## Options

- Keep the gateway content-blind and wait for the controller to add an installation-scoped notification API and gateway credential.
- Ship one package but run a notification daemon and one MCP proxy process per agent.
- Run notification polling, wake delivery, and an authenticated local MCP proxy in one per-user gateway process.

## Decision

Use one per-user gateway process for the short and medium term. The process:

- holds a central agent JWT reference for each configured binding;
- long-polls the binding's central message stream;
- accepts only an opaque message ID on the notification path;
- durably records that ID before acknowledging it;
- wakes the configured local runtime; and
- exposes an approved set of central MCP tools through an authenticated loopback endpoint, injecting the binding's central JWT instead of accepting it as a tool argument.

For the provisional central mapping, use `GET /api/poll_messages?timeout=<seconds>` and `POST /api/ack_message`. One authenticated poll runs per binding. The JWT and local configuration imply the binding. A returned message `id` acts as both the notification and delivery ID until the controller supplies distinct IDs.

The inspected controller does not yet provide durable redelivery, idempotent acknowledgement, expiry metadata, or a wake-report operation. Those remain integration requirements. Do not weaken the durable relay state machine to match the current controller implementation.

The exact proxied tool catalog, JWT enrollment and reissue flow, local MCP transport, caller-authentication mechanism, per-binding configuration shape, and CLI changes require separate user approval before tests or implementation. Registration or verification tools must not return a central JWT through the local proxy. A local caller must not select a binding or central JWT through an untrusted tool argument.

The gateway must not automatically retry an MCP tool call after the request may have reached the central service. The approved tool catalog must define idempotency and uncertain-outcome behavior for every side-effecting tool.

## Data boundary

The combined process is no longer content-blind or outbound-only. MCP requests and responses may pass through its memory.

The notification parser remains ID-only. SQLite, the durable outbox, configuration, diagnostics, metrics, and logs remain MCP-content-free. They must never retain task text, prompts, attachments, responses, results, permission details, grants, tool arguments, central JWT values, or MCP request and response bodies. ADR `0004-journal-shape.md` remains in force.

The local MCP endpoint must bind to loopback, authenticate every caller, enforce request and response size limits and deadlines, and map the authenticated caller to one fixed binding. It must not accept central JWTs in MCP tool arguments or return them in tool results.

The process must acquire its singleton lock before it resolves central JWTs, starts polling, binds the local MCP listener, or forwards any tool call. Temporary spooling is forbidden. Core dumps, minidumps, heap snapshots, crash reports, and support bundles are durable outputs and must be disabled or configured so they cannot capture MCP bodies or JWT values.

## Costs

One process now holds several agent JWTs and transiently handles MCP content. A process compromise has a larger blast radius, and the project can no longer claim that the gateway process never sees task or permission data.

The combined process also adds a local inbound interface and creates cross-binding isolation work. In return, it matches the available central identity model and gives independently running agents one stable local endpoint.

This is an intentional interim design. Revisit it when the controller can issue a restricted installation credential and deliver opaque binding notifications independently of agent MCP credentials.

## Dependencies and packaging

No MCP library, local authentication library, or new runtime is selected by this decision. Compare standard-library and maintained-library options before implementation, record any approved dependency separately, and write failing security and proxy tests first.

The proxy remains part of `@a2adev/gateway`; this decision does not add another package or executable.

## Approval

The user selected the combined process as a short- and medium-term design on 2026-08-25 and asked to document it for later review.
