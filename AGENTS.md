# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol.md`
4. `docs/implementation-plan.md`
5. Relevant accepted records under `docs/adr/`, especially ADR 0037 for
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
- The gateway follows the current
  [`embassys/agent2agent`](https://github.com/embassys/agent2agent) REST
  service at `https://mcp.embassys.ai`. Review current server code and live
  behavior before changing the integration. Update gateway code, fixtures,
  protocol, and qualification evidence together when the server contract
  changes.
- The gateway does not connect to the central MCP endpoint, discover central
  MCP tools, put a token in MCP arguments, probe alternate routes, or select
  an API version at runtime.
- Registration, verification, and resend use `/api/register_agent`,
  `/api/verify_email`, and `/api/resend_verification`. Registration is
  email-based. Verification sends the generated P-256 public JWK in the JSON
  body and intercepts the returned token before generic result handling.
- Protected central requests send `Authorization: Bearer <token>` and a
  separate `DPoP: <proof>` header. A nonce is optional and is used only after
  the server supplies one.
- Persist the DPoP-bound token and P-256 private key only as one atomic
  encrypted credential. Never put either value in MCP arguments or results,
  URLs, SQLite, diagnostics, metrics, logs, temporary files, crash artifacts,
  or support bundles.
- Do not add old-client support, central MCP fallbacks, speculative versioned
  routes, credential migration, activation, token reissue, leases,
  conversations, replies, or outcomes unless the current server adds the
  behavior and the user accepts the client change.
- The server currently consumes messages when `/api/poll_messages` returns
  them. Keep message bodies in bounded memory and the notification journal
  ID-only. Do not invent local body persistence or server redelivery.
- The local MCP listener always binds to `127.0.0.1`, validates `Host` and
  `Origin`, and checks the webhook bearer token before parsing a request.
- Write or update tests and CI expectations before production implementation.
- Do not select or install a framework, library, runtime, package manager,
  database driver, or build tool without explicit user approval.
- Get user approval for any CLI change before writing CLI tests or code. Get
  user approval before adding publication or installation tooling.
- Record approved architecture and dependency changes under `docs/adr/`.
- Keep open gateway work in `docs/implementation-plan.md` and optional server
  work in `docs/central-follow-ups.md`. Do not leave completed work as a TODO.
- A health response and fixture success do not prove live compatibility. Run
  the controlled live qualification for client-visible server changes.
- A production central MCP implementation, ACP, hosted-agent connectors, and
  GUI work remain out of scope.
