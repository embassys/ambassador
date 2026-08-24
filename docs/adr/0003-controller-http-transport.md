# 0003 Controller HTTP transport

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The protocol document defines logical controller operations but not HTTP paths. The client and fake controller need one concrete mapping before tests can run.

## Options

- Fix a small REST mapping in v1.
- Make every path configurable. This adds configuration and test combinations without changing protocol behavior.
- Generate a client from the controller repository. No controller schema or package is available here yet.

## Decision

Use this provisional REST mapping:

```text
GET  /v1/sidecar/notifications
POST /v1/sidecar/notifications/{notification_id}/ack
POST /v1/sidecar/wake-reports
```

The poll request sends `cursor`, `wait_seconds`, and `max_notifications` as query parameters. The first request omits `cursor`. All requests send the protocol messages from `docs/protocol-v1.md` as JSON where a body applies.

The controller base URL is configurable. Paths are fixed for v1. Successful acknowledgement and report calls return `204` or an idempotent `2xx` response.

Controller authentication uses `Authorization: Bearer <installation-token>` for the development contract. Configuration stores only the environment-variable or file reference used to load that token.

## Costs

The central controller may choose different paths or authentication. If it does, update this ADR and the client before a public release. Keeping transport code behind one client limits that change.

## Security

Production controller URLs require HTTPS. Tests may use loopback HTTP. Tokens never appear in query parameters or structured logs.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
