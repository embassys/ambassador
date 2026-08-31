# Development TODOs

- [ ] I01: pin the latest server revision from
  `https://github.com/embassys/agent2agent`; inventory every REST route, MCP
  tool, template, callback or event, version, and deprecation; trace all flow
  impacts; compare the deployed schemas with the accepted contract; then
  update gateway integrations, fixtures, reviewed inventories, and CI tests
  before production code. This recheck is not limited to DPoP or auth.
- [ ] As part of I01, confirm the exact schemas, consent behavior, and result
  handling for the two new user-email and user-phone request templates.
- [ ] I02: switch a fresh development identity to the pinned server DPoP
  deployment and pass issuance binding, bearer rejection, protected REST and
  MCP, reissue, activation, message lifecycle, crash recovery, packed install,
  and artifact E2E. Prefer an I01-approved email- or phone-request template to
  a calendar action, use synthetic or disposable data, and prove no contact
  value reaches persistence or logs.
- [ ] After I01 confirms the live verification-email format, add a manual,
  local-only Mailosaur helper for I02. Use its HTTPS REST API directly with no
  new SDK or dependency. Read the API key, server ID, and catch-all inbox domain
  from macOS Keychain service
  `ai.embassys.ambassador.development.mailosaur`, under the `api-key`,
  `server-id`, and `inbox-domain` accounts. Generate a unique address under the
  catch-all domain for each enrollment or recovery identity. Search only for
  that address and the current run's time window, retrieve the matching
  message, extract the accepted six-character code only in memory, and delete
  the message in cleanup. Never put a Keychain value, generated address, email
  body, or verification code in the repository, a `.env` file, command
  arguments, logs, or test output.
- [ ] Keep the Mailosaur-assisted I02 loop within its 2,000-email daily
  allowance. Treat one authenticated central identity as a qualification
  session and run every compatible issuance-binding, bearer-rejection,
  protected REST and MCP, reissue, activation, message-lifecycle, restart, and
  artifact check before enrolling another identity. Use a new address and
  identity only when the contract requires fresh issuance, lost-issuance
  recovery, or email-control recovery. Do not add Mailosaur to CI or treat its
  result as release evidence.
- [ ] Remove `--verbose=true`, its transcript code, tests, and ADR 0022 exception after the hosted central registration, verification, message polling, and acknowledgement flow is stable and exposes useful machine-readable errors.

Human reviews, external central work, real-provider qualification, and release
gates are tracked in the [human work queue](human-work.md).
