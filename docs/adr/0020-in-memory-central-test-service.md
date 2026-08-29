# 0020 In-memory central test service

Status: accepted

Date: 2026-08-25

Updated: 2026-08-29 to approve independent DPoP cryptography in the fixture

## Problem

End-to-end tests need the central REST and MCP boundaries without PostgreSQL, Gmail, external credentials, or a public service. The inspected private central repository has no license file, so its source cannot be copied into this repository.

## Decision

Independently implement a test-only service with the same documented HTTP and MCP contracts. Keep all agents, verification codes, JWTs, messages, permissions, and acknowledgements in memory. Use a deterministic test verification code and test-only message injection endpoints. Restarting the container intentionally clears all state.

Run the fixture in one pinned container based on `python:3.13.15-slim-trixie@sha256:7e3a6aca9d74f93cca21a91d86a8dad8c34749afd5b4a98ee481c9c47b9f5ed4`. Pin FastAPI `0.141.1`, FastMCP `3.4.7`, Pydantic `2.13.4`, and Uvicorn `0.52.4`. FastAPI and Pydantic use MIT, FastMCP uses Apache-2.0, and Uvicorn uses BSD-3-Clause. Lock the complete transitive dependency set with hashes before merging the fixture.

For the version 2 fixture, use PyCA `cryptography==50.0.0` directly for
P-256 key generation and loading, PKCS#8 serialization, and ECDSA signing and
verification. The approved CPython 3.13 manylinux x86-64 wheel hash is:

```text
sha256:06a32a980526a6ab9a4b9bf8f7385800791e2bb960903cb6b530e4817509a3b7
```

That exact wheel is already present in `requirements.lock` as a transitive
package. Direct fixture use adds no package or image layer. The Docker build
continues to require hashes, binary wheels, and `linux/amd64`; it fails instead
of compiling from source when the approved wheel is unavailable.

`cryptography` is maintained by the Python Cryptographic Authority, declares
`Apache-2.0 OR BSD-3-Clause`, supports Python 3.13, and is classified as
production/stable by its maintainers. This approval applies only to the
independent test fixture. It adds no gateway runtime dependency and does not
approve another JWT, JOSE, OAuth, HTTP, or validation package. Fixture code
must parse and validate the strict ADR 0026 DPoP profile itself, then use
`cryptography` only for the approved key and signature operations.

Sources: [version 50.0.0 package metadata](https://pypi.org/project/cryptography/50.0.0/),
[supported platforms](https://cryptography.io/en/stable/installation/), and
[upstream release history](https://cryptography.io/en/stable/changelog/).

Do not update this pin alone or automatically. Review upstream security and
maintenance releases whenever the fixture dependency set changes and when a
relevant advisory appears. A version change requires user approval, complete
lock regeneration with hashes, notice review, image rebuild, independent DPoP
vectors, and the full Docker fixture suite. Version `50.0.1` existed when this
decision was recorded but is not selected by this approval; a later refresh
must assess it with the complete locked set.

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

The user requested a Dockerized central MCP and polling fixture with in-memory email verification on 2026-08-25 and explicitly approved the pinned Python, FastAPI, FastMCP, Pydantic, and Uvicorn stack on 2026-08-25. On 2026-08-27, the user directed the protocol and fixture to match the live central API. On 2026-08-29, the user approved direct test-only use of the already locked `cryptography==50.0.0` wheel and its recorded hash for independent ES256 and DPoP verification.
