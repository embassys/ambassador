# 0065 Desktop registration with the existing API

Status: accepted

Date: 2026-09-07

The user approved the smaller development flow proposed in the
[API review](../desktop-api-review-2026-09-07.md): first-time registration in the
app, read-only agent permission/status views and notifications for locally
observed work. This amends ADR 0064's requirement to wait for owner accounts
before providing these features. It does not authorize server changes or a release.

The app explicitly selects one compiled-in direct executor, independently of MCP
client identification. Registration and verification use the existing REST and
encrypted credential services through private host/worker IPC. No token, private
key, email-link credential or provider credential reaches the renderer. The
six-digit verification code exists only during the explicit verification call.
The CLI bootstrap and supported MCP tool catalog remain unchanged. App-owned
instances direct unregistered MCP callers to finish registration in the app.

Persist bounded owner-only registration metadata before submission. Restart and
repeated clicks cannot repeat an uncertain registration or verification. A lost
registration response may still be followed by the code the human received;
a lost verification response requires central recovery if no local credential
was committed. Resend is explicit and locally rate-limited. Already verified
identity state remains authoritative even if later activation fails. Changing
email or executor must not replace an enrolled identity or pending attempt.

Permissions are a bounded, read-only agent-scoped snapshot from
`get_my_permissions`, with incoming/outgoing direction and status. Label missing
audit/use information and distinguish unavailable/offline/expired from an empty
list. Local status pages use existing durable stores and never submit receipts,
restart an intentionally stopped server, or create a competing central poller.
Approvals, owner answers and revocation remain through the existing email flow.

Running-app notifications use Electron's existing OS notification API. Send only
generic text for captured incoming actions, results, permission outcomes and
recorded owner questions. Record bounded identity-scoped event IDs before display,
coalesce bursts and never treat display or click as an approval or receipt. An
explicit local preference controls notifications. A click selects the matching
instance and view; it cannot execute work. No remote push or closed-app delivery
is claimed. Central owner authentication, durable owner feeds, recovery and push
remain API follow-ups. No dependency is added.

Regression coverage must include malformed/private IPC, executor and email
binding, conflicts, invalid codes, retries, lost responses, restart, expired
credentials, stopped reads, concurrent registration, notification duplicates,
two identities/instances, disabled notifications and failed display. Run the
packaged Mac form against a disposable central identity and inspect the actual
permission/status views and notification behavior.
