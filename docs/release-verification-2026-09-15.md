# Public releases and download verification, September 15

The owner authorized a final public desktop release and asked why the 0.1.3
links did not work. Embassys 0.1.4 is published as the latest regular GitHub
release. Both `draft` and `prerelease` are false. Ambassador remains at 0.2.20.

## Why 0.1.3 links returned 404

The desktop release was still a draft. The previous finalization stopped after
npm's version endpoint returned 404 immediately after the successful publication
job. It did not retry that check and never published the desktop draft. A draft's
authenticated asset listing did not mean that users could download those files.

The public release page and Mac download both reproduced the 404 before repair.
On September 15 the npm endpoint returned 200, and independent verification
matched all 364 candidate files. A fresh installation passed its command and
business flow checks, production audit and all 141 package signatures.

The original 16 desktop files matched the qualified CI artifacts and GitHub's
asset digests. The existing release was then published with both flags false.
Its original `desktop-v0.1.3-preview.1` tag is retained so shared URLs keep working;
its files were not replaced with the newer UI. Every original asset was downloaded
without authentication and matched its expected SHA-256 digest.

[Original 0.1.3 downloads](https://github.com/embassys/ambassador/releases/tag/desktop-v0.1.3-preview.1),
[npm release and verification report](https://github.com/embassys/ambassador/releases/tag/v0.2.20).

## Embassys 0.1.4

[PR 48](https://github.com/embassys/ambassador/pull/48) merged the desktop controls
and version update as `2d0db356674fd8c6cce32c1ee239edab79a98520`. Candidate
`df8577e557e42f1e8419c57c46f6ff8360f33c3e` and merge have the identical tree
`ca442aa83b77b2d6a5983c9d6f43093905ba6962`.

The candidate passed [shared/core checks](https://github.com/embassys/ambassador/actions/runs/34910406165)
and [desktop packaging](https://github.com/embassys/ambassador/actions/runs/34910406317).
The merge passed [all core, fixture and platform package checks](https://github.com/embassys/ambassador/actions/runs/34910780906)
and [all four desktop package checks](https://github.com/embassys/ambassador/actions/runs/34910780900).
The release uses the candidate's verified CI downloads.

All four archives were independently extracted and compared with their complete
inventories. The Mac application passed strict ad hoc signature verification,
matched the locally built renderer and host files, and started its bundled Node,
SQLite and MCP worker with an isolated PATH. Windows and Linux native startup
ran on their own CI runners; the Mac extraction checks do not qualify those
platforms' desktop/provider experience.

The 46 desktop checks and populated Electron mouse/keyboard walkthrough are
recorded in [desktop controls](desktop-controls-2026-09-14.md). The gateway did
not change, so the existing deployed-service qualification remains applicable.

The release's public API record identifies `desktop-v0.1.4` as latest, with all
16 expected asset names and download URLs. Uploaded bytes match the verified
build files. All 16 public 0.1.4 downloads were then fetched without credentials
and matched their expected hashes. Together with the restored 0.1.3 files, all
32 application and companion downloads passed public verification. Public-download reports live under `.build/release-0.1.3` and
`.build/release-0.1.4`; npm evidence is also attached to its GitHub release.

## Completion rule

Future release completion must check public metadata and fetch every download
without credentials, following redirects and matching expected hashes. Allow
bounded retries for registry visibility immediately after publishing. If a step
fails, retain an explicit incomplete status and resume it; never report the
release complete from an uploaded draft or authenticated download alone.

Regular GitHub release status does not add verified publisher signing,
automatic updates, native push qualification or production platform support.
The existing development body-log policy and installation limits still apply.
