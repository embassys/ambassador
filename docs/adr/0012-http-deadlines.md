# 0012 HTTP deadlines

Status: accepted; amended by ADRs 0037 and 0038

Date: 2026-08-23

Updated: 2026-09-02 for ACP delivery

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
| Webhook delivery | 10 seconds |
| ACP process initialization | 15 seconds |
| ACP session creation or resume | 15 seconds |
| ACP prompt | 15 minutes |
| ACP cancellation grace | 10 seconds |
| ACP child cleanup after cancellation | 5 seconds |

Tests may inject shorter positive deadlines through internal seams. The CLI
does not expose deadline options.

Clients reject redirects and bound response bytes. A timeout, cancellation,
redirect, or oversized response produces a safe typed error without URLs,
credentials, headers, bodies, or remote error text.

Do not automatically retry a central side effect after it may have reached the
server. One server-provided DPoP nonce may repeat the same request once with a
fresh proof. Message polling and webhook delivery follow their separately
tested rules.

One 15-minute-and-30-second outer ACP delivery budget includes initialization,
session setup, prompt execution, cancellation, and child cleanup. A stage never
extends the outer budget. Once prompt submission may have happened, a timeout
is uncertain and does not trigger automatic replay.

Central MCP deadlines from the original record are superseded because the
Ambassador no longer uses central MCP.

## Approval

The user approved the original limits on 2026-08-26, the REST-only amendment
through ADR 0037 on 2026-09-01, and bounded ACP delivery through ADR 0038 on
2026-09-02.
