# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol-v1.md`
4. `docs/implementation-plan.md`
5. `docs/decisions-to-review.md`
6. Relevant accepted records under `docs/adr/`, especially ADR 0037 for
   central integration work

If a task conflicts with these documents, stop and ask. Do not expand the
scope on your own.

## Project rules

- One foreground gateway process owns one webhook target and one enrolled
  central identity. Do not add bindings, runtime discovery, configured local
  runtime IDs, general configuration, or native service management.
- `start` accepts only `--webhook-url=<url>` and
  `--webhook-token-env=<name>`. The webhook token also authenticates every
  request to the loopback MCP endpoint.
- The current central contract is ADR 0037. Pin gateway integration work to
  `embassys/agent2agent` commit
  `b769896b7cfb1ee3540195be9e7a61cf777b9388` until a deliberate contract
  refresh changes that pin.
- The gateway uses the central REST API at `https://mcp.embassys.ai`. It does
  not connect to the central MCP endpoint, discover central MCP tools, put a
  token in MCP arguments, probe alternate routes, or select an API version at
  runtime.
- Registration, verification, and resend use `/api/register_agent`,
  `/api/verify_email`, and `/api/resend_verification`. Registration is
  email-based. Verification sends the generated P-256 public JWK in the JSON
  body and intercepts the returned token before generic result handling.
- Protected central requests send `Authorization: Bearer <token>` and a
  separate `DPoP: <proof>` header. Follow the deployed proof shape in ADR
  0037. A nonce is optional and is used only after the server supplies one.
- Persist the DPoP-bound token and P-256 private key only as one atomic
  encrypted credential. Never put either value in MCP arguments or results,
  URLs, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts,
  or support bundles.
- This is a development cutover. Do not keep bearer-only central support,
  central MCP fallbacks, speculative `/api/v2` routes, old credential readers,
  migration code, activation, token reissue, lease, conversation, reply, or
  outcome compatibility paths.
- The current server consumes messages when `/api/poll_messages` returns them.
  Keep message bodies in bounded memory and the notification journal ID-only.
  Document the resulting restart-loss limitation; do not invent local body
  persistence or a server lease contract.
- The local MCP listener always binds to `127.0.0.1`, validates `Host` and
  `Origin`, and checks the webhook bearer token before parsing a request.
- Write or update tests and CI expectations before production implementation.
- Do not select or install a framework, library, runtime, package manager,
  database driver, or build tool without explicit user approval.
- Get user approval for any CLI interface change before writing CLI tests or
  code. Get user approval for publishing and installation plans before adding
  distribution tooling.
- Record approved architecture and dependency changes in `docs/adr/` and keep
  `docs/human-work.md` current.
- Use the deployed `get_email` and `get_phone_number` action schemas recorded
  in the source inventory. Refresh them deliberately if the central catalog
  changes.
- A health response and fixture success are supporting evidence only. For live
  central claims, record the source revision and the observed REST behavior.
- A production central MCP implementation, ACP, hosted-agent connectors, and
  GUI work remain out of scope.
