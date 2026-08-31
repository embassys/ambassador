# Instructions for agents

## Read first

Before starting any task, read these files in order:

1. `docs/README.md`
2. `docs/product-vision-and-architecture.md`
3. `docs/protocol-v1.md`
4. `docs/implementation-plan.md`
5. `docs/decisions-to-review.md`
6. Relevant accepted records under `docs/adr/`

If your task conflicts with these documents, stop and ask. Do not expand the scope on your own.

## Project rules

- One foreground gateway process owns one webhook target and one enrolled central identity. Do not add bindings, runtime discovery, configured local-runtime agent IDs, general configuration, or native service management.
- `start` accepts only `--webhook-url=<url>` and `--webhook-token-env=<name>`. The webhook token also authenticates every request to the loopback MCP endpoint.
- Keep shipped `0.2.6` compatibility behavior distinct from the accepted next contract. ADRs 0023, 0025, and 0026 define the next contract, but the production central service does not yet implement or advertise it.
- Keep the notification journal ID-only. Never write task text, responses, permission details, grants, tool arguments, email addresses, verification codes, or MCP bodies to SQLite, configuration, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- The accepted target sends registration, verification, and resend through the fixed REST bootstrap routes in ADR 0023. Verification creates the first version 2 credential. Scheduled same-key reissue and explicit email-control recovery are the only credential-replacement paths. A `401`, invalid token, proof failure, key failure, or ordinary tool failure never triggers refresh or replacement.
- Intercept every verification, reissue, and recovery token before generic result handling. Persist the token and P-256 private key only as the atomic encrypted version 2 credential in ADRs 0019 and 0026. A DPoP-bound token may appear transiently only in a gateway-to-central `Authorization: DPoP` header or while calculating `ath`. Never put it in MCP arguments or results, URLs, the journal, diagnostics, metrics, logs, temporary files, crash artifacts, or support bundles.
- Registration, verification, and resend do not use a central access token, but they are not unauthenticated locally. Verification carries the issuance proof required by ADR 0026. The MCP listener always binds to `127.0.0.1`, validates `Host` and `Origin`, and checks the webhook bearer token.
- The accepted message target uses the fixed REST v2 lifecycle and central lease redelivery in ADR 0025. Do not persist message bodies, add a capability probe or fallback, or treat the `0.2.6` consuming-poll crash loss as the target behavior.
- Write tests and configure CI before production implementation.
- Do not select or install any framework, library, runtime, package manager, database driver, or build tool without explicit user approval.
- Get user approval for the CLI interface before writing CLI tests or code.
- Get user approval for publishing and installation plans before adding distribution tooling.
- Record approved architecture and dependency choices under `docs/adr/`.
- Respect task dependencies and file ownership in `docs/implementation-plan.md`.
- Follow the task gates in `docs/implementation-plan.md`. `docs/v2-fixture-profile.md` supplies test-only stand-ins for unknown central facts. Do not treat it or a development override as a production URL or as evidence that central implements the accepted target. A production central MCP implementation, ACP, hosted-agent connectors, and GUI work stay out of scope.
- For central integration work, pin the exact `embassys/agent2agent` source
  revision and the deployment built from it. Treat the supplied API snapshot
  and a health response as background evidence only. Follow I01 and I02 in
  `docs/server-integration-status.md`; never weaken an accepted contract or add
  runtime probing to match an unpinned server.
- Keep `docs/README.md` navigational, `docs/architecture-overview.md` concise,
  and `docs/human-work.md` current. Normative behavior belongs in the protocol
  or an ADR, not in the wiki summaries.
