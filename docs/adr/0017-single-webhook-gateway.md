# 0017 Single-webhook gateway

Status: superseded by ADR 0038

Date: 2026-08-25

Updated: 2026-09-01

## Problem

The gateway needs a small local boundary. A user already has one webhook and a
local secret. The gateway should not discover runtimes, configure bindings,
select a provider, or manage a service.

## Decision

One foreground process owns one webhook target and, after enrollment, one
central identity. It starts only as:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<name>
```

The process binds an authenticated Streamable HTTP MCP endpoint at
`127.0.0.1:8787`. The webhook token also authenticates every local MCP
request. Host and Origin checks run before body parsing.

Before enrollment, local MCP exposes registration, verification, and resend.
After enrollment, it exposes fixed tools backed by the current central REST
API. The gateway owns those local schemas. It does not discover central MCP
tools or accept a central token from the local agent.

One process has no binding table, configured runtime ID, provider option,
general configuration file, setup subcommand, service installation, or native
daemon management.

## Central integration amendment

ADR 0037 replaces the earlier bearer and proposed versioned sections:

- registration is email-only at `/api/register_agent`;
- verification submits a P-256 public JWK in its JSON body;
- protected calls use `Authorization: Bearer` plus a separate DPoP proof;
- every central gateway flow uses REST;
- polling uses the current consuming message endpoint; and
- no legacy client, central MCP fallback, API-version selection, or state
  migration remains.

## Notification and wake

The gateway validates a bounded message batch, keeps bodies in memory, and
stores only present IDs and relay state in SQLite. It sends an ID-only webhook
wake with bearer authentication, an HMAC signature, and duplicate-suppression
headers.

The local agent retrieves the body through local MCP and acknowledges an
ID-bearing message after processing. The gateway removes local state only
after central confirms `acked`.

The current server marks a polled message delivered and cannot redeliver it.
A gateway restart can lose a consumed body. Startup removes stale ID-only wake
state rather than inventing content.

## Removed behavior

- runtime discovery and adapter selection in the gateway;
- bindings and configured local runtime IDs;
- central MCP transport and token arguments;
- bearer-only central credentials;
- `/api/v2` activation or message lifecycle;
- compatibility fallback and migration; and
- the development verbose transcript.

## Approval

The user accepted the single-webhook design on 2026-08-25 and the current REST
amendment through ADR 0037 on 2026-09-01.
