# Central service follow-ups

These are server changes tracked for
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). The production
review treats message custody, credential renewal, and listener
lifecycle as release limitations. Ambassador must not emulate missing server
contracts with compatibility branches. The user requested issues instead of
API code changes.

- [Issue 1: recoverable messages and bounded batches](https://github.com/embassys/agent2agent/issues/1).
- [Issue 2: credential renewal and identity recovery](https://github.com/embassys/agent2agent/issues/2).
- [Issue 3: listener lifecycle and bounded polls](https://github.com/embassys/agent2agent/issues/3).

- [Issue 4: recover accepted submissions after a lost response](https://github.com/embassys/agent2agent/issues/4).
- [Issue 5: tell the caller when an action is waiting for its owner](https://github.com/embassys/agent2agent/issues/5).
- [Issue 6: define and validate action result schemas](https://github.com/embassys/agent2agent/issues/6).

## Security and operations

- Reserve `ambassador_acp_tool_execution` as a reviewed internal human-input
  type or keep unverified internal types out of the public action catalog.
  `get_human_input` currently auto-creates the name with an empty schema.
  Ambassador filters that exact fixed name and legacy
  `acp_tool_execution_<32 hex>` rows left by pre-cutover live runs before it
  validates public actions. Central should remove those legacy rows after
  confirming no permissions reference them.
- Accept standard `+tag` aliases in email local parts. The current Pydantic
  pattern rejects addresses such as `name+agent@example.com` with `422` before
  registration or email delivery. Apply the same corrected validation to
  registration, resend, verification, permission, action, and invitation
  models.
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
- Remove the legacy protected respond, grant, and deny routes from the service
  and OpenAPI once server consumers use the email-only human decision path.
- Either connect invitation creation to first contact or remove the automatic
  invitation claim from server documentation.

## Message reliability

The consuming poll can lose a delivered message when the gateway crashes
before durable local capture. ADR 0061 now persists received message bodies,
but server-side retrieval or redelivery is still needed for a lost poll response.

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
`708f205bfaee5010eb86fcfae55967fb5d02071c`, `poll_messages` changes matching
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

[Issue 6](https://github.com/embassys/agent2agent/issues/6) tracks adding a
`result_schema` to each `list_action_types` entry and validating
`submit_action_result.result` against it. The existing `input_schema` describes
the payload sent by the caller, not the answer expected from the target. Until
central publishes a result schema, Ambassador can request only a generic JSON
object and cannot tell the user the exact fields for an arbitrary action.

A controlled-central test with real Claude desktop and OpenClaw on 2026-09-05
returned only an owner's approval decision as a successful free/busy result.
No calendar read happened. Prompt guidance now distinguishes approval from
execution, but it cannot enforce the shape of arbitrary action results. Result
schemas must also make permission-suffixed calendar actions unambiguous.

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

[Issue 2](https://github.com/embassys/agent2agent/issues/2) also covers recovery
after `ambassador clean` removes the local token and DPoP key. The local
gateway becomes unenrolled while central still rejects the verified address
as already registered. Deleting and re-registering the central agent creates
a new ID; old permissions cannot be assumed to authorize that replacement.
The server needs an owner-verified recovery contract that distinguishes token
renewal with the existing key from recovery after losing it. Recovery cannot
restore local data that the owner deleted.
