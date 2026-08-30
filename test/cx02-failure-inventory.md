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

The initial slice contains four top-level nodes: three support guards are
green and X26 is reviewed red. The only reviewed marker is
`CX02-CX03:X26`, emitted solely for `ERR_MODULE_NOT_FOUND` at the exact absent
compiled adapter entry. A transitive missing module, syntax error, loaded
non-module value, wrong version or digest constant, or incomplete export
surface is unreviewed. Fixture, schema, loopback, process, reporter, timeout,
or unexpected stderr failures remain infrastructure failures.

The remaining ADR 0034 cases X01 through X25 and X27 will be added in the next
tests-only commit without advancing or weakening X26. CX04's real-provider
sandbox probe X08c, real Codex authentication, real home, and real containment
qualification remain outside CX02.
