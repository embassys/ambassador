# Implementation status

Status as of August 25, 2026.

## Approved target

- One foreground process starts with `--webhook-url=<url>` and `--webhook-token-env=<name>`.
- The CLI accepts only named `--name=value` options and has no setup, binding, runtime-discovery, configuration, or service-management flow.
- The process binds an authenticated Streamable HTTP MCP endpoint at `http://127.0.0.1:8787/mcp` and prints that address after successful startup.
- The webhook token authenticates both the outbound webhook and every local MCP request.
- Before enrollment, the MCP server exposes only registration, verification, and resend tools.
- A successful verification response supplies the central JWT. The gateway persists it, strips it from the local result, starts polling, and adds it only to future transient upstream MCP arguments and central poll authorization.
- One process owns one webhook and one central identity. There are no bindings or configured local-runtime agent IDs.
- The relay and SQLite remain ID-only. MCP content and plaintext credentials never enter durable relay state or observability outputs.

ADR `0017-single-webhook-gateway.md` records this design. Obsolete ADRs were deleted at the user's direction.

## Replacement source

PR `#5` implements the approved replacement on the reviewed test branch:

- strict two-option foreground `start` and lock-first startup;
- authenticated, bounded Streamable HTTP MCP on `127.0.0.1:8787`;
- bootstrap enrollment, encrypted JWT persistence, token-free verification, and authenticated tool proxying;
- ID-only SQLite notification state with independent persistence acknowledgement and webhook work;
- accepted-wake redrive until confirmed MCP `ack_message`;
- restart recovery and fixed safe errors; and
- deletion of setup, bindings, runtime adapters, JSON configuration, and native service management.

The local replacement suite covers the complete loopback flow and one container-gated FastMCP flow. Linux and macOS run the local suite in CI. The Linux Docker job tests the independent fixture, then runs the Node gateway through enrollment, notification delivery, content retrieval, and acknowledgement against the pinned FastMCP server. A separate Linux and macOS job packs the npm artifact, installs it into an empty prefix, and repeats that flow through the installed binary. Its Linux run also verifies webhook and MCP interoperability with OpenClaw `2026.7.1-2`, including the enrollment tool-list change. Windows CI is disabled after its strict credential DACL checks failed on the GitHub runner; Windows support and release qualification remain incomplete.

Version `0.2.0` adds paired `A2A_DEV_CENTRAL_API_URL` and `A2A_DEV_CENTRAL_MCP_URL` overrides so a developer can run the full flow before production endpoint constants exist. The release includes beginner setup guides for OpenClaw and Hermes Agent. Hermes uses its explicitly development-only, loopback-restricted unauthenticated webhook route because its generic webhook does not accept the gateway's bearer header.

## Production decisions

- ADR `0018-mcp-sdk.md` approves the official split MCP TypeScript SDK version 2 packages.
- ADR `0019-central-credential-storage.md` approves an AES-256-GCM credential file keyed from an OpenClaw-generated 192-bit webhook token.

The user approved the red failures and authorized production implementation on 2026-08-25. OS credential-vault storage and DPoP remain stronger future improvements; DPoP also requires central support.

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

PR `#4` recorded the reviewed red suite and failure inventory before production implementation. PR `#5` turns all eight expected failures green without changing their assertions. The Docker fixture independently implements the central contract with in-memory state; it copies no source from the unlicensed private central repository.

Docker runs in GitHub's Ubuntu runners. The Docker CLI is installed locally, but the local daemon is not running.

## Release blockers

- Obtain stable production central API and MCP URLs.
- Obtain a non-consuming production ID notification view.
- Obtain separate idempotent notification and content acknowledgements.
- Obtain structured central verification results.
- Obtain central JWT reissue and revocation behavior.
- Qualify packed installation and credential permissions on Windows.
- Verify trusted npm publishing after the `0.2.0` release PR merges to `main`.
