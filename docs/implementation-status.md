# Implementation status

Status as of August 25, 2026.

## Approved target

- One foreground process starts with `--webhook-url=<url>` and `--webhook-token-env=<name>`.
- The CLI accepts only named `--name=value` options and has no setup, binding, runtime-discovery, configuration, or service-management flow.
- The process binds an authenticated Streamable HTTP MCP endpoint at `http://127.0.0.1:8787/mcp` and prints that address after successful startup.
- The webhook token authenticates both the outbound webhook and every local MCP request.
- Before enrollment, the MCP server exposes only registration, verification, and resend tools.
- A successful verification response supplies the central JWT. The gateway persists it, strips it from the local result, starts polling, and adds it only to future transient upstream MCP arguments and central poll authorization.
- One process owns one webhook and one central identity. There are no bindings or agent IDs.
- The relay and SQLite remain ID-only. MCP content and plaintext credentials never enter durable relay state or observability outputs.

ADR `0017-single-webhook-gateway.md` records this design. Obsolete ADRs were deleted at the user's direction.

## Current `0.1.0` implementation

- Strict legacy controller, wake, and configuration schemas.
- Secure client for superseded `/v1/sidecar/...` controller paths.
- SQLite journal with atomic ingestion, acknowledgements, reports, retries, crash recovery, and singleton locking.
- Generic HMAC, Hermes, and OpenClaw wake adapters.
- Setup, agent management, diagnostics, foreground `run`, and native per-user services.
- Linux, macOS, and Windows CI.
- 142 automated tests.
- Public `@a2adev/gateway@0.1.0` package with the `a2a-gateway` executable.

This code is useful as a tested source of lock, SQLite, HTTP, and retry behavior, but its public interface and central contract are no longer the target. It will be replaced rather than kept for compatibility.

## Not implemented

- Strict two-option foreground `start`.
- Local MCP listener and MCP client.
- Shared webhook-token local authentication.
- Bootstrap-only tool catalog.
- Registration and verification forwarding.
- Structured JWT extraction, persistence, and token-free verification result.
- Post-verification JWT injection.
- Polling gated on enrollment.
- Single-stream ID-only central notification client.
- Agent-agnostic webhook body without `agentId`.
- Dockerized in-memory central service and full E2E test.

## Decisions before production code

- ADR `0018-mcp-sdk.md` recommends the official split MCP TypeScript SDK version 2 packages.
- ADR `0019-central-credential-storage.md` recommends an AES-256-GCM credential file keyed from the webhook token.

Neither decision installs a dependency or authorizes credential implementation yet. The red tests and Docker fixture come first.

## External central changes

- Add a non-consuming ID view such as `GET /api/poll_messages?timeout=30&view=ids`.
- Add idempotent `POST /api/ack_notification` for gateway persistence without consuming message content.
- Keep full message content available through the MCP `poll_messages` tool after the gateway observes its ID.
- Keep MCP `ack_message` as a separate idempotent content-processing acknowledgement.
- Return structured verification data so the gateway can extract exactly one JWT safely.
- Define JWT expiry, revocation, reissue, and deliberate local identity reset.

Token reissue is required for recovery if remote verification succeeds but the gateway cannot persist the one-time JWT before crashing.

The inspected central implementation currently returns message content and marks it delivered during REST polling. Its MCP wrapper calls the same endpoint and returns Python string representations. The target flow cannot be end-to-end safe against that behavior without central changes.

## Test work

The next code PR contains only tests, fixtures, CI, and minimal empty interfaces needed for useful failures. It remains red until user review.

The Docker fixture will independently implement the central contract with in-memory agents, verification codes, tokens, messages, and acknowledgements. The private central repository has no license file, so its source will not be copied.

Docker is available in GitHub's Ubuntu runners. The Docker CLI is installed locally, but the local daemon is not running.

## Release blockers

- Review the red test suite.
- Approve ADRs 0018 and 0019.
- Implement and pass the replacement tests.
- Run the E2E container in CI.
- Obtain stable production central API and MCP URLs.
- Qualify packed installation on clean Linux, macOS, and Windows environments.
- Publish a new version through GitHub OIDC after the implementation is ready.
