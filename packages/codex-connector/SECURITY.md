# Security

Do not pass the gateway webhook token as a command argument. Store it only in
the environment variable named by `--webhook-token-env` and restrict that
variable to the connector process.

The connector keeps message and provider content in memory. Its durable state
may contain only encrypted opaque identifiers, keyed indexes, lifecycle state,
and bounded retry timing. Do not attach connector state, provider transcripts,
tokens, working-directory contents, or crash dumps to a public report.

Report suspected vulnerabilities through the repository's private security
reporting channel. Include content-free reproduction steps and the exact
source commit. This private foundation has no provider or platform support
claim.
