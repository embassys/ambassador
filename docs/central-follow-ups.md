# Central service follow-ups

These are worthwhile changes to
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). They do not
block the gateway and the gateway must not emulate them with compatibility
branches.

## Security and operations

- Restore a finite verification-code expiry and compare timezone-compatible
  timestamps.
- Fail registration when the verification email cannot be sent, or return a
  delivery status that does not imply success.
- Expose a nonsecret build revision in `/health`.
- Bound and sanitize server errors. Do not return raw exception text that may
  contain user data.
- Use shared rate-limit state if the service runs more than one process.
- Add route tests for permission listing, invitation behavior, and expiring
  permissions.
- Remove or repair the duplicate grant and deny routes so one permission
  decision path remains.
- Either connect invitation creation to first contact or remove the automatic
  invitation claim from server documentation.

## Message reliability

The consuming poll can lose a delivered message when the gateway crashes
before acknowledgement. Server-side retrieval or redelivery would solve the
problem without storing other message bodies in the gateway or turning the
pending-action inbox into a delivery replay mechanism.

Investigate live delivery liveness after accepted permission writes. In two
controlled runs on 2026-09-02, central accepted the permission operation but
the corresponding recipient did not observe the queued message before the
qualification deadline: once for the initial request and once for the
response. The second run successfully delivered and acknowledged the initial
request before exhibiting the response failure. Keep this as a central
investigation; Ambassador must not infer success or add a speculative polling
or route fallback.

The Hermes 0.20.5 run on 2026-09-03 narrowed this problem. Central accepted one
correlated action result, but the requester did not receive its queued
`action_response` before the qualification deadline. The same target accepted
both incoming messages, made both required MCP calls, and received both
acknowledgements. A clean rerun passed.

At reviewed server revision
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`, `poll_messages` changes matching
rows from `queued` to `delivered` before it returns the HTTP response. An
aborted or lost response therefore strands the row without a lease or
redelivery path. The service runs four workers and keeps long-poll waiters in
process-local maps with one event per agent. Overlapping or abandoned polls can
race for the same row. This code path fits the transient failure, although the
content-free qualification record cannot prove which response or worker won.

A 2026-09-04 live run also observed an empty `poll_messages?timeout=30` remain
open beyond Ambassador's 40-second poll budget. In the same reviewed server
revision, `ensure_listening` acquires one connection from the finite listen
pool before entering the bounded `asyncio.wait_for`, caches that connection by
agent, and has no caller of `stop_listening`. Pool acquisition is therefore
outside the advertised timeout and registered identities can exhaust each
worker's listen pool. Bound listener setup, release listeners that are no
longer active, and cover listen-pool exhaustion in the server tests. The HTTP
request must return within the requested hold plus a small response margin.

Fix this in central with a database-backed delivery lease, stable message IDs,
lease expiry, and idempotent acknowledgement. Add server tests for a client
disconnect after claim, concurrent polls for one identity, worker handoff, and
lease expiry. LISTEN/NOTIFY may remain a wake-up optimization, but it cannot be
the custody boundary.

Any change should define duplicate handling and idempotent acknowledgement.
Update server tests, the gateway protocol, fixtures, client, and live
qualification together.

## Action-result hardening

Central now correlates `submit_action_result` by `call_id`, authorizes the
original target, records `completed` or `failed`, and queues an
`action_response` for the caller. The current operation has no per-action
output schema, idempotency key, or outcome lookup. A client that loses the
successful response cannot recover its message ID by repeating the request,
because a later submission returns `409`.

Define result size and nesting limits. Serialize competing submissions so two
requests cannot both observe `pending`, and add an idempotent recovery contract
before Ambassador retries an uncertain result submission.

Keep `call_id` as a required UUID in every queued `action_call` payload, not
only in the synchronous `call_action` response. Add a server contract test that
creates an action, polls it as the target, and proves the polled payload carries
the same `call_id` accepted later by `submit_action_result`. Ambassador's local
pending-action inbox cannot manufacture or recover this correlation value; a
missing or malformed value must remain a server-contract failure.

This also enables clean reconciliation of Ambassador's encrypted pending-action
inbox. Today, if central accepts a result but the response is lost or the local
delete fails, Ambassador cannot prove completion and may continue to show a
stale local row. An idempotent submission response or authorized outcome lookup
should let it remove that row without guessing.

## Credential lifecycle

Token refresh, revocation, and deliberate identity recovery would improve
long-running installations. They should keep the private key local and must
not turn an ordinary `401` into automatic identity replacement.
