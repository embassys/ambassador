# K02 classified implementation inventory

Status: K03 runtime-hardening oracle against production commit `dc332db`

K02 specifies the accepted connector foundation in ADRs 0024 and 0028 through
0032. It uses the K01 authenticated gateway and scripted provider port plus
K02-only raw-socket, deterministic-clock, fault-proxy, and process-observation
seams. No test selects a Codex, Claude Code, or Gemini executable, SDK,
protocol, dependency, version, sandbox mapping, or support claim.

The normal green runner excludes `k02-*.test.js`. The existing classified
inventory CI runner includes K02 by default with T03 and T04:

```text
pnpm run test:build
node --test --test-concurrency=1 .test-dist/test/connector-fixtures.test.js
node scripts/run-red-inventory.mjs --suite=k02
node scripts/run-red-inventory.mjs
```

The reviewed K03 inventory remains exactly 69 top-level nodes, with no renamed,
added, skipped, or todo nodes. This hardening branch strengthens existing nodes
and intentionally makes the affected nodes red against `dc332db`. The remaining
loader guard still proves that a transitive missing dependency, syntax error,
non-module value, or incomplete export surface is not eligible for the
historical reviewed missing-entry marker. Any fixture error, loopback failure,
unrelated timeout, unhandled rejection, changed name, or changed node count
makes the classifier fail.

## Classified matrices

| Nodes | Coverage required from K03 |
| --- | --- |
| W01-W11 | Raw HTTP/1.1 request-line and header exact/one-over bounds; timestamp boundaries; replay and expiry capacity; 1 MiB body boundary; HMAC-before-JSON; literal and escaped-equivalent duplicate JSON member rejection; queued and active coalescing; header/request deadlines; socket/request capacity; framing and pipelining; method, Host, Origin, media type, bearer-before-held-body, HMAC, and non-reflection |
| Q01-Q03 | Retain and order-dispatch all 100 queued IDs without eviction; one conversation lane; two global turns; exact session resume; call `poll_messages` with exactly `{timeout:0}`; reject non-string message, conversation, sender-agent, and predecessor IDs with the fixed gateway failure; fail closed when that bounded result contains later work for a closed or unresolved uncertain conversation |
| P01-P10 | Complete start/resume/recover automata; sender-data boundary; K03-constructed argv/environment/shell record; durable approval waiting and running; one absolute deadline across delayed dispatch and restart recovery; approval wait through the remaining grace and containment; successful and failed qualified containment; injected-port crash invariants; state-publication barriers; malformed, misordered, wrong-execution, and late events |
| B01-B05 | 10,000/10,001 normalized events; 1,024/1,025-byte provider IDs; 262,144/262,145-byte progress; independent 8 MiB stdout/stderr exact and one-over capture; 262,144/262,145-byte final reply |
| O01-O06 | Exact completion mapping and reply bytes; reply-before-ack; uncertainty without redispatch; lost-open reply outcome lookup and exact-turn recovery before uncertainty; mailbox-full in-memory retry; one lifetime 1/2/4/8/16/30-second schedule; every accepted application result on its operation-specific branch; permanent, authentication, malformed, terminal-mismatch, unknown, and uncertain-transport results across reply, completion, outcome lookup, and acknowledgement |
| C01-C04 | All eight content-free crash seams; exact-turn recovery; received-only initial dispatch with a fail-closed state precondition; no dispatch of later durable work while startup recovery is unresolved; no redispatch from binding or turn-starting; outcome lookup before every recovered central-pending operation, including after a durable attempt claim; terminal acknowledgement and open completion retry; no restoration of a cleared reply plan |
| S01 | Exact environment scrubbing plus scans of state, working paths, spawn records, and normal artifacts for content, credentials, approvals, provider IDs, and sender-controlled settings |
| S09-S13 | Owner/correlation initialization crashes; correlation-only and mutually valid rollback behavior; durable 100,000-conversation and per-conversation open-message capacities; production local-filesystem qualification before state creation; effective-UID, protected-parent, hardlink, and explicit sync checks; startup rejects a partial marker as unavailable and an exact marker as retired; only `retire-state` repairs an exact protected prefix and resumes every sync and allowlisted deletion crash |
| A01-A08 | Exact strict SQLite schema and pragmas; 4 MiB target and 16 MiB hard WAL action boundary with checkpoint before external effect; full HMAC indexes; independent AES-256-GCM IV/tag envelopes; parent-bound AAD transplant rejection; every paired message/conversation transition atomic across injected crash seams; startup rejection of every disallowed lifecycle join; envelope/index/schema corruption; token/provider/directory scope binding; reply acknowledgement restores an active conversation while completion and its acknowledgement close both sides; mapping retention; unallowlisted artifact, ownership, hardlink, and permission failures |
| L01, SD01, B00 | Approved MCP client/HTTP transport initialization handshake and fixed 35-second gateway MCP timeout; non-resetting provider/grace/containment timers; exact fixed constants; parallel two-turn cancellation; SIGINT and SIGTERM-style shutdown proves cleanup or exits with `connector_shutdown_incomplete` inside one 15-second budget |
| D01-D05 | Exact public `start`/`retire-state` grammar and loopback foreground startup; public runtime fatal exits, listener closure, and fixed stderr; unpackaged shared core; exact private manifests; safe closed-provider build/stage gate; packed offline-install and command-smoke gate |

P05, P07, Q02, C01, and S01 have separate nodes for independent policy,
containment, scheduling, crash, environment, and artifact assertions. B00 locks
the complete non-configurable limit object in addition to behavior at each
boundary.

## Test-only construction seams

The red loader expects `packages/connector-core/src/index.ts` to export the
provider-neutral foundation, fixed limits, child-environment projection,
policy-ceiling check, and bounded provider-output consumer. The internal
constructor accepts injected K01 ports, a fake gateway endpoint, temporary
state directory, deterministic clock, content-free state/crash barriers,
delayed-dispatch and state-action observation, durable capacity seeding, and a
trusted process observer. The fake gateway also permits one raw poll result so
the public CLI can be tested against an invalid gateway response. These are
repository test seams, not CLI options, configuration, provider selection,
runtime discovery, or packaged crash controls.

## Focused red signatures at `dc332db`

- P06 recomputes the deadline after delayed dispatch, does not arm the stored
  remaining interval during recovery, and drops approval waiting before the
  absolute grace and containment sequence finishes.
- SD01 performs no containment proof for active executions and resolves when
  incomplete cleanup must reject with `connector_shutdown_incomplete`.
- D02 leaves the real public CLI and listener running after a runtime gateway
  fatal instead of exiting with the fixed stderr contract.
- S12 reaches missing-token handling before production filesystem, effective
  UID, and parent-chain qualification, and emits no explicit initialization
  file/directory sync evidence.
- S11 ignores durable open-message capacity seeding; A01 performs no observed
  PASSIVE checkpoint above 4 MiB and accepts work while the WAL remains above
  the 16 MiB hard boundary.
- W06 accepts escaped-equivalent duplicate webhook members. Q03 either drops,
  accepts, or leaks type-dependent errors for non-string gateway IDs instead of
  returning `connector_gateway_operation_failed`.

Provider attachment qualification remains out of this inventory and is owned
by the later provider ADR work.

During the K03 implementation read, Q03 and S13 were corrected to match the
already accepted ADRs. Q03 no longer invents a `message_ids` poll argument;
it proves the later bounded poll used exactly `{timeout:0}` before the
uncertain-conversation stop. S13 now distinguishes a nonexact retirement
marker (`connector_state_unavailable` on startup) from the exact permanent
marker (`connector_state_retired`), while confirmed `retire-state` remains the
only operation allowed to finish an exact protected prefix. These are test
corrections, not contract changes, and do not change the 69-node inventory.

A later lifecycle review strengthened C01, C03, O03, A04, and A07 without
adding a top-level node. The added assertions directly exercise the accepted
ADR 0029 and ADR 0030 recovery, dispatch-gating, paired-state, and lifecycle
join rules. They do not increase a timeout, relax a contract, or change the
reviewed 69-node inventory.

Production startup remains ADR 0028's provider-specific entrypoint with the
fixed gateway MCP endpoint, account-derived state root, four required options,
and no test faults. K04 still owns the later normal-process fake E2E. Each
provider/platform qualification still owns its exact raw provider envelope,
real process tree, PID-independent owner-death containment, and support claim;
K02 makes no process-tree qualification claim. Windows connector support and
qualification are deferred; K02 runs on the Linux and macOS lanes only.

## Provisional implementation decisions for review

- The delayed-dispatch seam is a content-free millisecond barrier after the
  durable dispatch decision and before the provider port call. The state-action
  observer reports only `{kind: "wal_checkpoint", mode: "PASSIVE"|"TRUNCATE"}`
  and `{kind: "external_effect"}`; it carries no identifier, path, or content.
- Durable capacity seeding may create up to two content-free open message rows
  for quota qualification. It is not a production maintenance or recovery
  interface.
- The production filesystem oracle exercises the shared state core through the
  Codex public entrypoint and intercepts Node's synchronous, callback, and
  promise filesystem probes. D02 separately exercises runtime-fatal shutdown
  through every provider entrypoint.
- K03 owns three repository-only package gate entrypoints:
  `scripts/build-connector.mjs`, `scripts/stage-connector.mjs`, and
  `scripts/check-packed-connector.mjs`. The root `connectors:check` command is
  exactly `node scripts/connectors-check.mjs` and composes those closed-provider
  operations without invoking the classified K02 runner recursively.
- State initialization, capacity seeding, retirement crash injection, and
  provider-dispatch proof are test-only constructor seams. They are absent from
  public CLI options and must not be copied into staged packages as controls.
- Public CLI and clean-installed shim tests replace `node:os.userInfo()` from a
  Node preload outside connector arguments so destructive first-run state stays
  under a temporary test account home. The connector exposes no home or state
  override, and the preload is neither staged nor a supported runtime control.
- The K01 fake provider's session-only recovery is qualification evidence only
  for the provider-neutral automaton. A real adapter cannot select that branch
  until its provider ADR proves a non-creating exact-turn lookup.
