# 0045 Self-contained adapters and permission inbox

Status: accepted

Date: 2026-09-03

## Problem

The Codex and Claude Code profiles required users to install their ACP adapters
separately. A missing adapter emitted an asynchronous child-process error that
escaped Ambassador's bounded failure path. Startup also printed only the MCP
URL, leaving users to find provider-specific setup elsewhere.

The central permission list contains both requests made by this identity and
requests awaiting its decision. `get_my_permissions` exposes all of them, but
does not give an agent an obvious answer to “what is waiting for my response?”

## Decision

- Install exact `@agentclientprotocol/codex-acp` 1.8.0 and
  `@agentclientprotocol/claude-agent-acp` 0.73.0 as Ambassador production
  dependencies.
- For those profiles, resolve the package from Ambassador's own installation,
  validate the fixed package name, bin mapping, bounded version, and contained
  JavaScript entrypoint, then launch it with the current Node executable and no
  shell. Never download an adapter at runtime or use a same-name executable
  from `PATH`.
- OpenClaw and Hermes remain external agents and provide their own reviewed ACP
  commands.
- Treat both synchronous and asynchronous spawn failures as bounded delivery
  failures. Print safe operator guidance for local-state, listener, agent,
  initialization, uncertain-delivery, and generic delivery failures without
  exposing raw exception text or provider output.
- After the listener is ready, print ready-to-copy MCP setup commands for all
  four supported agents, the natural-language registration prompt, and the
  foreground-process reminder.
- Add `list_pending_permission_requests`. It makes the existing protected
  `GET /api/get_my_permissions` call and returns only pending rows where the
  enrolled email is `grantor_email`, plus a count. It adds no central endpoint,
  durable queue, or automatic decision. The user still chooses a returned ID
  and `respond_to_permission` submits `granted` or `denied`.
- Describe tools with both Embassys and Ambassador intent language, including
  ordinary requests such as “register me,” while keeping exact schemas and
  names.

## Consequences

The initial npm installation is substantially larger because the two adapter
dependency trees include provider runtimes for the current platform. In
exchange, Codex and Claude Code users need only the documented Ambassador
command and their normal provider sign-in. Package installation, audits, and
cross-platform checks cover the adapters.

The permission inbox is a filtered current view, not a notification guarantee.
It remains available after an incoming notification was acknowledged because
central permission state is authoritative until the user decides it.

## Approval

The user approved embedding the adapters, the setup and diagnostic changes,
the pending-request tool, and a follow-up release on 2026-09-03.
