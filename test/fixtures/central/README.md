# In-memory central test fixture

This fixture independently implements the central boundaries used by gateway end-to-end tests. It does not contain source from the inspected central service. All agents, codes, tokens, permissions, actions, messages, and delivery state disappear when the process stops or `POST /__test/reset` runs.

## Container contract

- Streamable HTTP MCP: `http://127.0.0.1:8000/mcp`
- Health: `GET /healthz`
- Readiness: `GET /readyz`
- Message poll: `GET /api/poll_messages?timeout=30`
- Message acknowledgement: `POST /api/ack_message`
- Test-control header: `X-A2A-Test-Key: central-fixture-control`

`/api` requests use the central token as a bearer token. The MCP catalog matches the inspected central service:

- Bootstrap: `register_agent`, `verify_email`, and `resend_verification`
- Authenticated: `list_action_types`, `request_permission`, `respond_to_permission`, `call_action`, `poll_messages`, `get_my_permissions`, and `ack_message`
- Token-free health check: `health_check`

`register_agent` requires a 3-50 character `username` and `email`; `display_name` is optional. Every authenticated tool requires `token`. `health_check` and the bootstrap tools do not accept it.

The protected test endpoints are:

- `POST /__test/reset` with no body
- `POST /__test/verification-code` with `{"email":"agent@example.test"}`
- `POST /__test/messages` with a verified `recipient_agent_id`, `content`, and optional `message_id`, `sender_agent_id`, and `kind`
- `POST /__test/inspect` with optional `agent_id` and `message_id` filters

The verification code is always `246810`. The code lookup endpoint is the only test endpoint that returns it. Inspection returns IDs and each message's `queued`, `delivered`, or `acked` status. It never returns registration fields, tokens, permission details, action details, or message content.

REST and MCP `poll_messages` consume the same queue. A poll returns each full queued message once and atomically marks it delivered, so the other interface cannot poll it again. REST and MCP `ack_message` accept only delivered messages and return `{"message_id":"...","status":"acked"}`. A second acknowledgement fails.

## Local container tests

`requirements.lock` contains CPython 3.13 manylinux x86_64 wheel hashes. Build and test the fixture as `linux/amd64`; the lock does not claim cross-architecture support.

```sh
docker build --platform=linux/amd64 --target test --tag a2a-central-fixture-test .
```

The `test` target copies `test_app.py` and runs `python -m unittest -v test_app.py` during the build. It needs no bind mount or volume.

Build and run the default runtime image with:

```sh
docker build --platform=linux/amd64 --tag a2a-central-fixture .
docker run --rm --platform=linux/amd64 -p 127.0.0.1:8000:8000 a2a-central-fixture
```

The default image runs one non-root Uvicorn worker with access logging disabled.
