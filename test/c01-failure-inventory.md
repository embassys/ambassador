# C01 CI inventory

Status: current CI inventory after I02 through I04

The former C01 split between `0.2.6` and a future version is superseded. The
replacement CI has one central contract.

Required lanes:

| Lane | Purpose |
| --- | --- |
| Linux Node | Current gateway contract, connector inventory, and unaffected regression tests |
| macOS Node | Current gateway contract, connector inventory, and unaffected regression tests |
| Ubuntu container | Independent Python current-contract fixture and packed gateway smoke |
| Linux and macOS package | Clean install, startup, local MCP, artifact scan, and no obsolete central path |

Windows remains deferred under ADR 0033.

The red-inventory runner contains only the reviewed K02, CX02, and CL02
provider-side suites. Superseded T03 and T04 central suites are absent.
