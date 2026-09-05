# 0058 Confirm stopping a running process

Status: accepted

Date: 2026-09-05

## Decision

When `start` or `clean` finds a running Ambassador, offer to stop it and
continue. Ask only in an interactive terminal and default to No. An empty
answer, a negative answer, end of input, or cancellation never authorizes
shutdown. Non-interactive commands keep the existing `daemon_running` error.
There is no force flag or new public command.

Use Ambassador's authenticated private control route to identify the running
instance before asking. On confirmation, send a stop request naming that
instance. Each foreground start has a new random instance ID kept in memory.
A later process must reject a stop request intended for an earlier one, even
when they share local state. The control secret keeps its existing encrypted
custody and never appears in prompts or output.

The stop request follows the same graceful shutdown path as a terminal signal.
The requesting command then waits up to 30 seconds to acquire the singleton
lock. Only owning that lock permits a new start or local cleanup. An unavailable
control route, an invalid lock, a changed process instance, or a shutdown that
does not finish produces a bounded error. Do not signal an arbitrary PID, kill
a process using the MCP port, force shutdown, or delete the lock to continue.

ADR 0053's private route gains exact `process.status` and `process.stop`
operations with the existing Host, Origin, authentication, and body checks.
They are not MCP tools. Session deletion and forgetting remain stopped-only.
Central APIs and provider configuration are unchanged.

## Approval

The user asked for `clean` and `start` to ask whether to stop another running
Ambassador and proceed. This approves the CLI behavior and amends ADRs 0039,
0044, and 0053. Cleanup still requires proof that Ambassador has stopped before
deleting state.
