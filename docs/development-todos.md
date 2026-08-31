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
- [ ] Remove `--verbose=true`, its transcript code, tests, and ADR 0022 exception after the hosted central registration, verification, message polling, and acknowledgement flow is stable and exposes useful machine-readable errors.

Human reviews, external central work, real-provider qualification, and release
gates are tracked in the [human work queue](human-work.md).
