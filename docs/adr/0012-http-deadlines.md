# 0012 HTTP deadlines

Status: accepted; amended by ADR 0037

Date: 2026-08-23

Updated: 2026-09-01 for the REST-only central client

## Problem

Local or central HTTP work can otherwise remain open forever and block
polling, webhook retries, MCP calls, or clean shutdown.

## Decision

Every HTTP operation combines caller cancellation with an internal deadline:

| Operation | Deadline |
| --- | --- |
| Central REST call | 30 seconds |
| Central message long poll | 40 seconds for a server-held 30-second poll |
| Local MCP request | 35 seconds |
| Webhook wake | 10 seconds |

Tests may inject shorter positive deadlines through internal seams. The CLI
does not expose deadline options.

Clients reject redirects and bound response bytes. A timeout, cancellation,
redirect, or oversized response produces a safe typed error without URLs,
credentials, headers, bodies, or remote error text.

Do not automatically retry a central side effect after it may have reached the
server. One server-provided DPoP nonce may repeat the same request once with a
fresh proof. Message polling and webhook wakes follow their separately tested
rules.

Central MCP deadlines from the original record are superseded because the
gateway no longer uses central MCP.

## Approval

The user approved the original limits on 2026-08-26 and approved the REST-only
amendment through ADR 0037 on 2026-09-01.
