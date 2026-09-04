# 0053 Live session inspection

Status: accepted

Date: 2026-09-04

## Problem

ADR 0050 made ACP sessions observable, but all session commands took the
singleton process lock. An owner therefore had to stop message delivery just
to list session metadata or read provider history. Letting a second CLI process
open an ACP adapter independently would also allow session inspection to race
with delivery and retention cleanup.

## Decision

Allow `sessions list` and both forms of `sessions show` while `ambassador
start` is running. Keep `sessions delete` and `sessions forget` stopped-only.

The foreground process hosts a private control route on its existing loopback
HTTP listener. This route is not MCP and is not part of the agent-facing tool
catalog. It accepts only exact bounded operations for listing session metadata
and showing one session. It requires the exact loopback Host, rejects every
Origin, accepts no redirects, and authenticates with a generated 256-bit bearer
secret.

Ambassador creates the control secret internally and stores it encrypted with
separate owner-only wrapping material. The secret is never accepted through
the CLI, MCP, environment, or a prompt, and it is never printed or logged. The
public `/mcp` route continues to reject every Authorization header.

When a read command finds that the foreground process owns the singleton lock,
the CLI loads the internal secret and calls the fixed control route on
`127.0.0.1:8787`. The running process performs `show` with the fixed provider
profile and serializes it with direct delivery and retention cleanup. When the
foreground process is stopped, read commands retain ADR 0050's direct local
behavior under the singleton lock.

If the lock is held but the authenticated control route is unavailable, the
read command fails with a bounded error. It does not bypass the lock, inspect a
different endpoint, or start another adapter.

`clean` removes the encrypted control secret and its wrapping key with the rest
of Ambassador's local state. This does not add a public option or change the
fixed MCP endpoint.

## Consequences

- Owners can inspect sessions without pausing incoming delivery.
- The foreground process remains the only process that controls ACP while it
  is running.
- A malicious process already running as the same local owner remains inside
  the accepted local-machine trust boundary.
- Provider deletion and local metadata deletion still require an explicit
  stopped-state command.

## Approval

On 2026-09-04, the user asked for session listing and display to work while the
CLI is running and approved implementation of the foreground control design.
