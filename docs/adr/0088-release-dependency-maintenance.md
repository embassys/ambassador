# ADR 0088: Release dependency maintenance

Status: Accepted under the owner's September 16 instruction to complete the
work and testing needed for release.

The release audit found Hono 4.13.4 in the existing MCP dependency graph. Hono
4.13.5 fixes three moderate advisories concerning static-site output paths,
dot-notation form parsing and fragment/query interpretation:

- [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv)
- [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)
- [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx)

Refresh only this transitive lockfile entry and its peer references to 4.13.5.
It satisfies the existing MCP dependency ranges, adds no dependency and retains
the same Node engine requirement. Its August 26 publication passes the existing
24-hour minimum age. Use the registry's published integrity value and verify
registry signatures after installation. Do not introduce an override, change
direct dependencies or relax supply-chain controls.

The desktop build uses this frozen lockfile. A fresh CLI installation resolves
its dependencies through the existing package ranges, so qualify that installed
graph separately as well. Full local platform checks and all platform CI gates
must pass on the resulting release candidate. This maintenance does not replace
the required deployed-service qualification.

## Codex native qualification follow-up

The live packaged-app test then reached Codex but failed because bundled Codex
0.152.1 could not use the owner's existing `gpt-6-astra` selection. Refresh the
already approved wildcard ACP dependency in the lockfile. The unchanged 24-hour
minimum age selects `@agentclientprotocol/codex-acp` 1.11.0 with Codex 0.153.4;
adapter 1.12.0 is still too new. No package name, direct requirement, ACP SDK
version, provider model, authentication or approval policy changes. Retest the
native connection, dependency audit, signatures and packaged platform gates
before treating the refreshed adapter as qualified.
