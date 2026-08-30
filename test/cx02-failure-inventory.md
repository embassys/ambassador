# CX02 classified Codex adapter inventory

Status: expected red against the exact missing CX03 production adapter

CX02 specifies the accepted Codex App Server 0.149.0 adapter in ADR 0034. It
uses a byte-pinned stable schema fixture and a full-process fake executable
over JSONL stdio. The fake is selected only by a direct test constructor; no
public CLI option, environment variable, executable selector, dependency,
provider authentication, or Codex home is involved.

The normal green runner excludes `cx02-*.test.js`. The classified inventory
runner includes CX02 by default on the existing Linux and macOS jobs:

```text
pnpm run test:build
node scripts/run-red-inventory.mjs --suite=cx02
node scripts/run-red-inventory.mjs
```

The complete inventory contains 31 top-level nodes: three support guards are
green and the 28 adapter behaviors X01-X07, X08a-X08b, and X09-X27 are
reviewed red. Each red node has its own `CX02-CX03:<ID>` marker, emitted solely
for `ERR_MODULE_NOT_FOUND` at the exact absent compiled adapter entry. A
transitive missing module, syntax error, loaded non-module value, wrong version
or digest constant, or incomplete export surface is unreviewed. Fixture,
schema, loopback, process, reporter, timeout, and unexpected stderr failures
remain infrastructure failures.

The behavior files cover these accepted groups:

- X01-X08b: executable identity, direct launch, pinned schema, handshake,
  durable binding order, crash sides, stored-thread resume, and sealed policy.
- X09-X15: untrusted input placement, turn binding, output normalization,
  terminal selection, failures, approvals, and unsupported server controls.
- X16-X19: interruption, exact-turn recovery, null-turn refusal, and bounded
  memory-only history inspection.
- X20-X23: raw JSONL and common limits, history mutation, and content/auth/test
  control exclusion from execution, staged, and packed surfaces.
- X24-X25 and X27: fake owner death, provider-neutral foundation integration,
  two-turn/thread and two-conversation behavior, and teardown before terminal
  publication.
- X26: strict missing-production classification.

CX04's real-provider sandbox probe X08c, real Codex authentication, real home,
and real Codex containment qualification remain outside CX02. X24 and X27 use
only the fake App Server and foundation test hooks and make no real-process-tree
support claim.
