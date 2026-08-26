# 0012 HTTP deadlines

Status: accepted

Date: 2026-08-23

Updated: 2026-08-26 after user review

## Problem

Local or central HTTP work can otherwise remain open forever and block polling, webhook retries, MCP calls, or clean shutdown.

## Decision

Every HTTP operation combines caller cancellation with an internal deadline:

| Operation | Deadline |
| --- | --- |
| Central ID long poll | 40 seconds for a server-held 30-second poll |
| Central MCP connection | 5 seconds |
| Central MCP tool call | 30 seconds unless a shorter approved tool limit applies |
| Local MCP request | 35 seconds |
| Webhook wake | 10 seconds |

Tests may inject shorter positive deadlines. V1 does not expose deadline options on the CLI.

Clients reject redirects and bound response bytes. A timeout, cancellation, redirect, or oversized response produces a safe typed error without URLs, credentials, headers, MCP bodies, or remote error text.

Do not automatically retry a central MCP tool call after it may have reached the server. ID polls and webhook wakes follow their separately tested retry rules.

## Costs

A slow central tool or webhook fails even if it would eventually complete. Bounded uncertainty and shutdown are more important than waiting indefinitely.

## Approval

The user delegated the original choice on 2026-08-23 and authorized documentation updates for the single-webhook design on 2026-08-25. On 2026-08-26, the user approved the 30-second server-held poll, 10-second transport margin, and fixed non-configurable deadlines.
