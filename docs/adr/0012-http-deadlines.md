# 0012 HTTP deadlines

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

An outbound controller or runtime request can otherwise remain open forever. That would stop polling, durable outbox delivery, wake retries, and clean service shutdown.

## Decision

Every HTTP client combines the caller's cancellation signal with an internal deadline:

| Operation | Deadline |
| --- | --- |
| Controller long poll | Configured poll wait plus 10 seconds |
| Controller acknowledgement or wake report | 10 seconds |
| Runtime wake | 10 seconds |
| Runtime health probe | 5 seconds |

Tests may inject shorter positive deadlines. Production configuration does not expose these values in v1.

The client still rejects redirects. A deadline failure produces a safe typed error or retryable wake outcome without including URLs, credentials, headers, or response bodies.

## Costs

A controller or local runtime that cannot respond within the deadline will be retried. The controller endpoints and native runtime webhooks are expected to acknowledge scheduling rather than wait for task completion.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
