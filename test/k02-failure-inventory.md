# K02 classified implementation inventory

Status: provider-neutral connector foundation implemented by K03

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

The reviewed K03 inventory is 69 top-level nodes: 69 green, zero red, zero
skipped, and zero todo. The 68 production-backed nodes preserve the exact
accepted K02 names and behavior boundaries. The remaining green loader guard
proves that a transitive missing dependency, syntax error, non-module value, or
incomplete export surface is not eligible for the historical reviewed
missing-entry marker. Any regression, fixture error, loopback failure, timeout,
unhandled rejection, changed name, or changed node count makes the classifier
fail.

## Classified matrices

| Nodes | Coverage required from K03 |
| --- | --- |
| W01-W11 | Raw HTTP/1.1 request-line and header exact/one-over bounds; timestamp boundaries; replay and expiry capacity; 1 MiB body boundary; HMAC-before-JSON; queued and active coalescing; header/request deadlines; socket/request capacity; framing and pipelining; method, Host, Origin, media type, bearer-before-held-body, HMAC, and non-reflection |
| Q01-Q03 | Retain and order-dispatch all 100 queued IDs without eviction; one conversation lane; two global turns; exact session resume; call `poll_messages` with exactly `{timeout:0}`; fail closed when that bounded result contains later work for a closed or unresolved uncertain conversation |
| P01-P10 | Complete start/resume/recover automata; sender-data boundary; K03-constructed argv/environment/shell record; durable approval waiting and running; absolute deadline; successful and failed qualified containment after the remaining grace; injected-port crash invariants; state-publication barriers; malformed, misordered, wrong-execution, and late events |
| B01-B05 | 10,000/10,001 normalized events; 1,024/1,025-byte provider IDs; 262,144/262,145-byte progress; independent 8 MiB stdout/stderr exact and one-over capture; 262,144/262,145-byte final reply |
| O01-O06 | Exact completion mapping and reply bytes; reply-before-ack; uncertainty without redispatch; lost-open reply recovery; mailbox-full in-memory retry; one lifetime 1/2/4/8/16/30-second schedule; every accepted application result on its operation-specific branch; permanent, authentication, malformed, terminal-mismatch, unknown, and uncertain-transport results across reply, completion, outcome lookup, and acknowledgement |
| C01-C04 | All eight content-free crash seams; exact-turn recovery; received-only initial dispatch; no redispatch from binding or turn-starting; committed-lost-reply outcome lookup; no restoration of a cleared reply plan |
| S01 | Exact environment scrubbing plus scans of state, working paths, spawn records, and normal artifacts for content, credentials, approvals, provider IDs, and sender-controlled settings |
| S09-S13 | Owner/correlation initialization crashes; correlation-only and mutually valid rollback behavior; 100,000-conversation capacity; injected local-filesystem qualification; startup rejects a partial marker as unavailable and an exact marker as retired; only `retire-state` repairs an exact protected prefix and resumes every sync and allowlisted deletion crash |
| A01-A08 | Exact strict SQLite schema and pragmas; full HMAC indexes; independent AES-256-GCM IV/tag envelopes; parent-bound AAD transplant rejection; paired transition atomicity; envelope/index/schema corruption; token/provider/directory scope binding; acknowledgement cleanup and mapping retention; unallowlisted artifact and permission failures |
| L01, SD01, B00 | Approved MCP client/HTTP transport initialization handshake and fixed 35-second gateway MCP timeout; non-resetting provider/grace/containment timers; exact fixed constants; parallel two-turn cancellation; bounded SIGINT and SIGTERM-style 15-second shutdown |
| D01-D05 | Exact public `start`/`retire-state` grammar and loopback foreground startup; unpackaged shared core; exact private manifests; safe closed-provider build/stage gate; packed offline-install and command-smoke gate |

P05, P07, Q02, C01, and S01 have separate nodes for independent policy,
containment, scheduling, crash, environment, and artifact assertions. B00 locks
the complete non-configurable limit object in addition to behavior at each
boundary.

## Test-only construction seams

The red loader expects `packages/connector-core/src/index.ts` to export the
provider-neutral foundation, fixed limits, child-environment projection,
policy-ceiling check, and bounded provider-output consumer. The internal
constructor accepts injected K01 ports, a fake gateway endpoint, temporary
state directory, deterministic clock, content-free state/crash barriers, and a
trusted process observer. These are repository test seams, not CLI options,
configuration, provider selection, runtime discovery, or packaged crash
controls.

During the K03 implementation read, Q03 and S13 were corrected to match the
already accepted ADRs. Q03 no longer invents a `message_ids` poll argument;
it proves the later bounded poll used exactly `{timeout:0}` before the
uncertain-conversation stop. S13 now distinguishes a nonexact retirement
marker (`connector_state_unavailable` on startup) from the exact permanent
marker (`connector_state_retired`), while confirmed `retire-state` remains the
only operation allowed to finish an exact protected prefix. These are test
corrections, not contract changes, and do not change the 69-node inventory.

Production startup remains ADR 0028's provider-specific entrypoint with the
fixed gateway MCP endpoint, account-derived state root, four required options,
and no test faults. K04 still owns the later normal-process fake E2E. Each
provider/platform qualification still owns its exact raw provider envelope,
real process tree, PID-independent owner-death containment, and support claim;
K02 makes no process-tree qualification claim. Windows connector support and
qualification are deferred; K02 runs on the Linux and macOS lanes only.

## Provisional implementation decisions for review

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
