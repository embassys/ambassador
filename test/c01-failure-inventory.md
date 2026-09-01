# C01 CI inventory

Status: pending I02 rewrite

The former C01 split between `0.2.6` and a future version is superseded. The
replacement CI has one central contract.

Required lanes after I02:

| Lane | Purpose |
| --- | --- |
| Linux Node | Current fixture self-tests, I02 red classification, and unaffected regression tests |
| macOS Node | Current fixture self-tests, I02 red classification, and unaffected regression tests |
| Ubuntu container | Independent Python current-contract fixture and packed gateway smoke |
| Linux and macOS package | Clean install, startup, local MCP, artifact scan, and no obsolete central path |

Windows remains deferred under ADR 0033.

The current `test:red-inventory` command still classifies the superseded T03
and T04 suites. I02 must change the runner and this inventory before production
central code changes.
