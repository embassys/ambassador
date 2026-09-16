# September 16 release candidate

The owner requested all work and testing needed to make the release ready. The
candidate versions are CLI `embassys@0.2.22` and desktop `0.1.5`. Public versions
remain CLI 0.2.21 and desktop 0.1.4 until publication is verified.

## Included work

- Current central usernames, accepted-request lists, reviewed catalog discovery,
  read-only action progress and invocation-bound provider approvals.
- Existing exact grants remain usable when a peer closes new permission requests.
- Account communication history, segmented navigation and compact review dialogs.
- Correct setup and recovery guidance, including expired sign-in challenges.
- Cowork discovery guidance qualified with two fresh natural-prompt tasks.
- Hono 4.13.5 in the frozen MCP dependency graph, removing the three moderate
  audit findings. [ADR 0088](adr/0088-release-dependency-maintenance.md) records
  the exact change. Direct dependencies and supply-chain controls are unchanged.

## Release gates

The complete Mac qualifier passed all 14 stages on candidate `95c995e`. This
includes 633 repository tests with six expected skips, 53 desktop tests, two
clean-installed CLI checks, archive extraction, bundled workers, packaged host
lifecycle and CLI/app handoff. There were no test failures.

Both candidate workflows passed all ten required jobs:

- [Core, independent Python REST fixture and native/installed packages](https://github.com/embassys/ambassador/actions/runs/35066701266)
- [Desktop builds and distributions on Mac, Windows, Linux x64 and Linux ARM64](https://github.com/embassys/ambassador/actions/runs/35066701263)

The frozen production audit reports no vulnerabilities and verifies all 248
registry signatures. Clean-installed dependency audits and signatures also pass
the platform gates. The background Mac app used 186 MiB across five processes
and 0.00% idle CPU during the ten-second sample. This measures an unenrolled
instance with no provider running.

The actual packaged Mac app was checked through its native interface with an
isolated profile. About shows version 0.1.5. The welcome and registration screens
render, invalid email is rejected locally, Stop/Start changes the server state,
Clean can be cancelled before stopping, and Escape closes the settings sheet
with focus restored. Closing the window leaves MCP available; quitting stops
the owned server. The temporary profile was removed. Screenshots and results
are retained with the candidate evidence. No live registration or protected
mutation was sent during this walkthrough.

The wall-clock MCP check held the initial request for 600.008 seconds and
returned its continuation. A later check resumed the same operation and
dispatched it once after permission arrived. There was one permission request
and one action call. This exercised the real SDK, Streamable HTTP and MessageBox
with a controlled central fixture; it does not qualify every provider's timeout.

Keep the release branch separate from main until the following deployed-service
checks pass. Merging a new CLI version to main triggers npm publication.

1. Register a disposable agent with a chosen username; complete verification and
   read the current catalog and initial unrestricted accepted list.
2. Publish selected and empty accepted lists on disposable peers. Check lookup by
   username, refusal outside the list, and an action through an existing exact
   grant after closing new requests. Complete and acknowledge its exact result.
3. Read owner communication history while a synthetic action remains queued.
   Then receive and complete that same action through the ordinary agent receiver,
   proving history reads did not consume execution work. Check retention metadata.
4. Finish registered native provider setup and owner approval/input walkthroughs,
   preserving normal provider authentication and exact offered options. Keep
   foreground waits as the supported path where native return remains unqualified.

The saved Mailosaur key returns 401 on the actual message-search endpoint as well
as the server-list endpoint. Safari has no signed-in Mailosaur session. The owner
has been asked to restore access or supply an inbox whose codes they can provide.
No signup is sent to an inaccessible inbox, no verification is bypassed, and
fixture success is not reported as a deployed-service pass.

The production OpenAPI document still contains 71 paths and its schemas match
the September 15 reviewed snapshot. Server main is still `d5365b7`. The last
native test evidence is recorded in [the release follow-up](release-readiness-2026-09-15.md).
New local build, audit and qualification evidence is under
`.build/release-candidate-2026-09-16/`.

## Known distribution limits

This is the existing unsigned desktop distribution, with ad hoc integrity signing
on Mac. Publisher signing, notarization, automatic updates and native remote push
remain separate prerequisites. The candidate keeps the approved development body
logging policy and its credential redaction and retention limits. No central API
implementation or new production logging policy is included.
