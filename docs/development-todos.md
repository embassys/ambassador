# Development TODOs

- [x] I02: replace the central fixtures, gateway contract tests, red
  inventories, and CI expectations with the current unversioned REST and DPoP
  contract.
- [x] I03: implement email-only REST enrollment, body JWK binding, the current
  30-day token claims, `Authorization: Bearer`, optional nonce handling, and
  one current encrypted credential format.
- [x] I03: delete bearer-only central credentials, central MCP transport,
  token arguments, REST-to-MCP fallback, reissue/recovery, migration, and the
  verbose transcript.
- [x] I04: implement fixed REST-backed action, permission, poll, permission
  list, and acknowledgement tools.
- [x] I04: delete activation, lease, conversation, reply, completion, and
  outcome clients and their fixture-only production wiring.
- [x] I05: run two disposable Mailosaur identities through registration,
  verification, DPoP negatives, permission request and decision, action call,
  poll, acknowledgement, restart, package, and artifact checks.
- [x] I05 kept Mailosaur secrets in the macOS Keychain service
  `ai.embassys.ambassador.development.mailosaur`. Keep generated addresses,
  codes, tokens, proofs, messages, and action payloads out of arguments, files,
  logs, and test output. Delete captured messages after use and stay within the
  500-message daily allowance.
- [ ] Central follow-up: correct `get_my_permissions`; the protected live call
  returned a server error matching the pinned response-field mismatch.
- [ ] After I05, redesign the optional provider connector around actual
  permission/action messages before rerunning real-provider qualification.

Human coordination and release approval are tracked in
[human-work.md](human-work.md).
