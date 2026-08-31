# Development TODOs

- [ ] I01: pin the latest DPoP revision from
  `https://github.com/embassys/agent2agent`, compare its deployed REST and MCP
  schemas with the accepted contract, then update gateway integrations,
  fixtures, reviewed inventories, and CI tests before production code.
- [ ] I02: switch a fresh development identity to the pinned server DPoP
  deployment and pass issuance binding, bearer rejection, protected REST and
  MCP, reissue, activation, message lifecycle, crash recovery, packed install,
  and artifact E2E.
- [ ] Remove `--verbose=true`, its transcript code, tests, and ADR 0022 exception after the hosted central registration, verification, message polling, and acknowledgement flow is stable and exposes useful machine-readable errors.

Human reviews, external central work, real-provider qualification, and release
gates are tracked in the [human work queue](human-work.md).
