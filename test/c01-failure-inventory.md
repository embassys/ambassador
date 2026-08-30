# C01 cross-platform failure inventory

Status: merged CI specification, intentionally red only inside the classified
future-v2 jobs

C01 keeps two contracts separate. The normal test command runs the shipped
`0.2.6` regression suite and must be green on Linux and macOS. The
red-inventory command runs the fresh-install future-v2 specifications on those
same platforms and succeeds only when their exact audited red classifications
remain unchanged.

Linux and macOS run the complete T03 and T04 inventory through the fast Node
fixture. Ubuntu also packs and installs the gateway, runs the shipped flow
against the independent Python container as a green regression, then
classifies a full future-v2 packaged smoke flow as red. This is the only packed
C01 lane.

None of these fixture results proves that the production central service
implements DPoP, lease redelivery, shared replay, or the other accepted
version 2 behavior.

## Commands

```text
pnpm run check
pnpm run test:red-inventory  # Linux and macOS
```

The Ubuntu packaged-container lane runs this after building the independent
fixture and installing the local tarball:

```text
A2A_FASTMCP_FIXTURE_URL=http://127.0.0.1:8000 \
A2A_PACKED_GATEWAY_CLI=<installed-dist-cli> \
  node --test .test-dist/test/fastmcp-e2e.test.js

A2A_FASTMCP_FIXTURE_URL=http://127.0.0.1:8000 \
A2A_PACKED_GATEWAY_CLI=<installed-dist-cli> \
  node scripts/run-red-inventory.mjs --suite=packaged-docker
```

## Audited `0.2.6` classification

| Lane | Behavior checks or vectors | Node test nodes | Pass | Expected red | Skip | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T03 on Linux and macOS | 129 vectors | 139 | 1 | 138 | 0 | 0 |
| T04 on Linux and macOS | 41 checks | 41 | 1 | 40 | 0 | 0 |
| Packaged gateway plus Docker v1 regression on Ubuntu | 1 check | 1 | 1 | 0 | 0 | 0 |
| Packaged gateway plus Docker future-v2 smoke on Ubuntu | 1 check | 1 | 0 | 1 | 0 | 0 |

T03 has 10 failing parameterized parents in addition to its 129 child vectors.
Its one green child is the existing closed verification-schema guard. T04 has
40 missing gateway behaviors and one green response-observer support check.
The packaged future-v2 smoke starts at REST enrollment, then specifies bound
verification, activation, leased receive, terminal completion,
acknowledgement, and an artifact scan. On `0.2.6` it stops at the first missing
REST-v2 enrollment boundary.

The inventory runner checks the exact compiled file list and the reviewed
file, nesting, full name, status, and failure boundary of every Node test node.
T03 and T04 bind existing structured failures to SHA-256 digests of their
error type, code, failure type, message, and normalized first test boundary.
The reporter never emits the underlying message or stack. The packaged smoke
uses an explicit non-sensitive marker after its exact fixture-state checks.
Exact node identities avoid prefix collisions such as B02/B02a and
B04/B04a/B04b. They also prevent one intended red case turning green while
another failure takes its place. The manifest records `skip` and `todo` as
false for every node, and the runner checks both fields before counting a
green pass.

The child output is memory-only and bounded to 4 MiB. Each suite has a fixed
wall-clock timeout, and timeout or overflow tears down its process group before
the classifier fails. The workflow job is also bounded. A changed boundary,
count change, status swap, missing or duplicate node, unexpected pass, skip,
process signal, stderr output, module failure, loopback bind failure, uncaught
exception, cancellation, or unhandled rejection therefore requires review
instead of being accepted as intended red behavior.

## Deferred Windows boundary

ADR 0033 removes Windows from the CI and initial-release matrices. The former
portable subset, injected access-control boundary, and platform skips were
never native Windows qualification. They remain historical C01 evidence only.
W01 is closed as deferred, not passed, and a Windows lane may return only under
a new approved plan with the complete native and packed evidence in ADR 0033.

## Platform evidence

The current normal-test CI matrix is Node `24.19.0` on `ubuntu-latest` and
`macos-latest`. The exact future-v2 red inventory runs on both. The packaged
Docker lane is Ubuntu `linux/amd64` only. GitHub Actions run `33282853898`
predates ADR 0033 and passed the former narrowed Windows subset alongside the
Ubuntu, macOS, Docker, and package lanes. That historical Windows job did not
qualify a native credential, process lifecycle, artifact scan, or package.

The user accepted the T03 and T04 classification on 2026-08-30, and PR `#28`
merged the complete C01 inventory. The external central S01 inventory and
central-owner review remain required before gateway production work begins.

The Linux and macOS jobs append a count-only classified-red table to their job
summaries. The expected-red runner exits zero only after the classification
matches, which separates a reviewed missing behavior from a broken test
environment while keeping the feature specification visibly red.
