# 0082 Current central recovery and owner integration

Status: accepted, 2026-09-14. After reviewing the new server contracts, the owner
requested implementation of everything available without server changes.

This amends ADRs 0037, 0061, 0068 and 0075 using the contracts reviewed in
[the September 14 review](../central-api-review-2026-09-14.md). Server code,
publication, new dependencies and changes to public CLI arguments are excluded.
Use the existing SDKs, crypto, encrypted stores, React and Electron.

## Agent recovery

Record the exact body and a stable operation-scoped idempotency key in encrypted
custody before supported central mutations. Persist the result before exposing
success. Reuse that key with identical input for reconciliation after response
loss or restart. Bound retries inside the server's documented retention window,
with a conservative local safety margin. Never infer non-execution from an
expired or absent record after that window. Keep an unresolved tombstone rather
than generating a replacement key. Only the current identity can reconcile its
work. No retry of an unkeyed historical mutation is authorized by this change.

Acknowledgement is now idempotent. Retry uncertain receipts with bounded
backoff, retaining the original message ID. Provider dispatch remains at most
once. Release a received batch that could not enter durable custody; a failed
release leaves recovery to central's lease. Storage failures stop reception,
without acknowledging or dispatching a partial batch.

Renew an expiring token using its retained P-256 key and atomically replace the
credential before using the new token. Serialize renewal, preserve the key used
by local encrypted stores, and use only the dedicated renewal route's reviewed
expired-token grace. Ordinary authentication failures never trigger identity
replacement. Explicit email recovery retains the central identity; it cannot
recover erased local ciphertext or silently change the key of existing stores.
Verification retries retain the same encrypted pre-request key for a 30-minute
reuse window. The owner supplies the code again; codes are never persisted.
An unused encrypted key is replaced on the next expired attempt or removed by
Clean, rather than being subject to a background deletion timer. Codes and
credentials never enter logs, SQLite or public IPC.

## Owner account and people

Replace `/api/app` with the current `/api/owner` contract in the separate private
account worker. Generate and retain the device key in encrypted file custody.
Keep owner tokens out of the renderer, gateway, MCP and diagnostics. The owner
and agent token realms stay distinct. Existing app-session tokens cannot be
converted to owner tokens; require owner sign-in while preserving local contacts
and history. A device binding does not mean bearer owner requests prove key
possession.

Use paginated inbox/grants/history and a persisted resumable owner event cursor.
Page independently of the execution queue; do not poll or acknowledge agent work
to refresh the app. Fetch exact current requests before decisions, preserve
provider options, and recover a saved owner's choice under its original key.
Account changes invalidate review handles, late responses and feed subscriptions.
Keep confirmed history distinct from uncertain local submissions.

People combines local contacts with authenticated invitations and connections.
Importing contacts never sends an invitation. Invite is an explicit user action;
show pending/accepted/declined status and exact recipient, prevent
duplicate sends, and reconcile lost responses through the supported contract.
Connections are social relationships, never action permission grants.

Expose registered devices and controlled executor transfer. Confirm the named
destination before changing which device executes an agent. Preserve one active
local owner per installation and existing CLI/app handoffs. Fenced credentials
must pause execution after transfer or device revocation, including transfer
away and back to the same device. Keep old readable local history; do not
silently overwrite the key that encrypts it.

## Progress, results and push

Use the catalog's exact `result_schema` to validate successful output before
dispatch and show providers the expected result contract. Errors remain valid
without matching a success schema. Do not map calendar permission names to data
actions. Schema absence is explicit and is not evidence of successful execution.

Correlate remote progress to the saved call and peer; deduplicate by sequence and
event ID. Progress can wake a waiting caller but cannot complete an action or
grant permission. Automatically report waiting for owner input when recording
a correlated question, without exposing the owner's private question or answer
as progress text. Keep ten-minute waits and explicit continuation.

Native push registers only reviewed platform tokens through private app IPC.
Treat delivery as a wake-up hint, fetch current owner state, and preserve running
app notifications on unsupported platforms. Signed identity, APNs/WNS credentials
and actual-device qualification remain prerequisites for claiming remote push.
No arbitrary renderer-supplied push endpoint or credential is accepted.

## Validation

Write boundary regressions before each implementation change. Cover concurrency,
key/body conflicts, lost responses, persistence failures, restart, expired replay
windows, revoked credentials, redelivery, exact permission and owner correlation,
stale reviews, email/app races, pagination and cancelled observers. Keep fixtures
aligned with reviewed server models. Use disposable live identities and native
app walkthroughs where the deployment permits them. Issue 15 initially blocked
protected agent qualification; the subsequent repair and successful controlled
live retest are recorded in the adoption record. Do not convert fixture results
into a live or publication claim. Keep remaining work in the plan.


## Execution credential installation

Only private main/worker IPC may carry an execution credential. Before selecting
this device, check the selected installation's identity, stop its app-owned
server and acquire its process lock. Refuse a running CLI or a different identity.
Hold that lock across selection, token issuance and atomic installation. An
unknown transfer response requires a fresh device review; never repeat it silently.
A confirmed server transfer with failed local setup remains visible as incomplete.

When a device key replaces the agent's original key, save the original credential
pair in a separate encrypted archive file before replacing the active credential.
Local workflow stores and peer-session identity continue using that archive key;
central requests use only the active device credential. Same-key renewal replaces
the active encrypted file with a compare-and-swap check. This preserves history
through later CLI/app handoffs and does not copy another installation's state.

Email recovery of an expired legacy credential reuses its key. Recovery after
local erasure establishes a fresh local key for the same central identity, without
claiming to recover deleted history. A lost recovery response requires a new code.
Known device-fenced credentials use Devices & agents instead of legacy recovery.

Owner event-cursor recovery pages the inbox with durable page progress. Commit
each page only after notification custody, then resume events from the initial
snapshot's watermark. New requests during the scan remain observable. Pending
request identities may label a conversation only when both local and remote
central agent IDs match and the owner roster includes the local identity.

The issue 19 repair restores offsets on invitation timestamps. Require offsets
for invitation and connection records, as for other central dates.

The completed issue 17 contract adds `GET /api/owner/agents`. Refresh and persist
the authoritative roster after registration and when opening account/device views,
without another sign-in or a change of account context. Check bounded unique IDs,
attachment membership, executor-device consistency and nonnegative epochs.
Re-read the roster before device review and submission; changed ownership,
verification or execution epoch invalidates the review. A roster read never
changes the selected executor.
