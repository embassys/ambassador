# 0020 In-memory central test service

Status: accepted

Date: 2026-08-25

## Problem

End-to-end tests need the central REST and MCP boundaries without PostgreSQL, Gmail, external credentials, or a public service. The inspected private central repository has no license file, so its source cannot be copied into this repository.

## Decision

Independently implement a test-only service with the same documented HTTP and MCP contracts. Keep all agents, verification codes, JWTs, messages, permissions, and acknowledgements in memory. Use a deterministic test verification code and test-only message injection endpoints. Restarting the container intentionally clears all state.

Run the fixture in one pinned container based on `python:3.13.15-slim-trixie@sha256:7e3a6aca9d74f93cca21a91d86a8dad8c34749afd5b4a98ee481c9c47b9f5ed4`. Pin FastAPI `0.141.1`, FastMCP `3.4.7`, Pydantic `2.13.4`, and Uvicorn `0.52.4`. FastAPI and Pydantic use MIT, FastMCP uses Apache-2.0, and Uvicorn uses BSD-3-Clause. Lock the complete transitive dependency set with hashes before merging the fixture.

FastAPI `0.115.6` and Uvicorn `0.34.0` from the inspected central repository are not compatible with FastMCP `3.4.7`; they are intentionally not reused.

The fixture independently implements the live consuming notification interface:

```text
GET /api/poll_messages?timeout=<seconds>
```

The response contains full messages and atomically changes them from queued to delivered. As in the inspected central MCP wrapper, authenticated upstream MCP tools accept a `token` argument and its `poll_messages` tool consumes the same queued stream.

`ack_message(message_id)` succeeds only for a delivered message and returns `{message_id, status: "acked"}`. The fixture intentionally has no `ack_notification` route or non-consuming ID view.

## Scope

The fixture proves registration, in-memory verification, JWT capture, removal from local schemas and results, transient upstream token injection, consuming full-message polling, gateway in-memory retrieval, `ack_message`, webhook wake, restart-loss handling, and redaction. It is not a production central server and does not test real email delivery or PostgreSQL behavior.

Test-control endpoints require a fixture-only header. They allow reset, verification-code lookup by JSON body, message injection, and ID/status inspection. They never return JWTs or message content. The container uses one non-root worker, no volumes, no access log, and no published CI port.

## Approval

The user requested a Dockerized central MCP and polling fixture with in-memory email verification on 2026-08-25 and explicitly approved the pinned Python, FastAPI, FastMCP, Pydantic, and Uvicorn stack on 2026-08-25. On 2026-08-27, the user directed the protocol and fixture to match the live central API.
