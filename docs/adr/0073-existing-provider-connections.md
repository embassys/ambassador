# 0073. Reuse valid owner-managed provider connections

Status: accepted under the owner's request to complete local setup and client
qualification, 2026-09-08.

The onboarding connection helper compared an existing provider entry with the
exact JSON that Embassys writes. A valid Claude HTTP connection without an
optional timeout therefore blocked setup, even though the executor check accepted
it. Owners should not need to replace working settings to finish onboarding.

Share one strict public entry validator between setup inspection and executor
checks. An unowned entry for the exact loopback endpoint may use the provider's
reviewed optional fields. Reject disabled, authenticated, executable, unknown or
different-endpoint entries. Accepting existing settings never edits them, records
ownership, claims a live model connection or guarantees a host's wait timeout.

An app-owned entry still must match exactly before repair or removal. This keeps
user edits protected. Command reconciliation also keeps its exact expected-state
check; a compatible result is not proof that the command succeeded.

Regression coverage precedes implementation and covers all four providers,
unchanged files, no ownership journal, refused removal, wrong ports and hostile
or unsupported fields. Qualify the existing Claude entry through the native app
and the complete real-agent request flow. No dependency, API, CLI option or
distribution change is involved.
