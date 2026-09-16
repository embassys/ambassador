# Release verification, September 16

[Embassys 0.1.5](https://github.com/embassys/ambassador/releases/tag/desktop-v0.1.5)
and [CLI embassys 0.2.22](https://www.npmjs.com/package/embassys) are public.
The desktop release is latest, with draft and prerelease both false.

[PR 53](https://github.com/embassys/ambassador/pull/53) merged as
`643b942c1fad232a40eb551a77fadfd88d78a9bb`. Candidate
`0d71742d45bb8d870f8852a6a23ddfab9b520204` and merge have the identical tree
`71c082a181e39e5b12b7a1212bb8bc7e793ec3d4`.

## Tests and live qualification

The final Mac qualifier passed all 14 stages, including 634 repository tests,
55 desktop checks, two clean-installed flows, packaged startup, archive checks
and CLI/app handoff. The candidate and merge passed every required platform
check. The main [CLI workflow](https://github.com/embassys/ambassador/actions/runs/35071802391)
also passed its publication checks; the
[desktop workflow](https://github.com/embassys/ambassador/actions/runs/35071802361)
passed on Mac, Windows, Linux x64 and Linux ARM64.

The owner repaired Mailosaur access. Live signup, accepted-request restrictions,
existing-grant dispatch and account-history queue isolation then passed against
the deployed API. The final packed CLI completed a second live round trip with
a controlled ACP peer. Its source is the published package's exact payload.

The actual Mac app completed one-code setup and a real Codex action, including
one-time approval, an owner question, a typed synthetic phone number and delivery
of that exact result. OpenClaw and Hermes Connect dialogs and fresh-session
identity checks passed. Native settings saved selected and empty accepted lists.
Two UI regressions found during these runs were fixed and retested. The bundled
Codex adapter was refreshed without changing the owner's model or credentials.

Screenshots and detailed scope are in the
[candidate record](release-candidate-2026-09-16.md). Claude Code's current login
was expired, so its new connection check is explicitly unverified. Earlier live
Claude onboarding remains separately documented. These tests do not qualify
experimental native conversation return or every platform's provider interface.

## Public downloads

The 16 desktop assets come from the successful
[candidate build](https://github.com/embassys/ambassador/actions/runs/35071218004).
Each of the four application archives was extracted and compared with its full
inventory. Their checksums, source digest and dependency inventories match. The
Mac app also passed strict ad hoc signature verification, matched the local
renderer/host files and started its bundled MCP worker with an isolated PATH.

Every asset was then fetched without GitHub credentials. All 16 URLs returned
HTTP 200 and their SHA-256 hashes matched the verified CI files. Anonymous GitHub
metadata confirms that 0.1.5 is the latest final release. The installation guide
links to these verified assets.

npm reports publication at `2026-09-16T08:09:35.568Z`. Its latest tag is 0.2.22,
and the archive's SHA-1/SHA-512 match registry metadata. The public payload is
byte-identical to the live-qualified candidate after decompression; only the
platform marker in the gzip wrapper differs. GitHub Actions provenance uses the
SLSA v1 predicate.

A fresh `npm install -g embassys` with an isolated prefix and empty cache installed
0.2.22. Its real command passed native SQLite, bare-command MCP startup, session
inspection, same-state restart, graceful shutdown and Clean with log retention.
Temporary installations and test state were removed.

Published npm archive SHA-256:
`a7a51f797c1e59ca709014c6f56cdc95efb3d9e5a47e704e13d3ba21fd0ba47a`.

## Cleanup and limits

The native test owner signed out. The test server stopped, its encrypted temporary
profile was removed, and captured test emails were deleted. Only provider
connections and discovery skills owned by that temporary app were removed;
unrelated settings and the pre-existing Claude connection were preserved.

Publisher signing, notarization, automatic updates and native remote push remain
separate prerequisites. Windows/Linux/Raspberry Pi native provider testing remains
outstanding. Development body-log retention is unchanged. Account history still
displays self-directed owner replies separately; this did not duplicate actions.
No central API implementation was changed.

Evidence is retained under `.build/release-candidate-2026-09-16/` and
`.build/release-0.1.5/`, including the native screenshots, CI reports, public
checksums, extracted archive checks and fresh public CLI installation results.
