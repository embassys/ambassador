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

Run the complete Mac qualifier on this candidate, including clean-installed CLI
flows, archive extraction, bundled workers, packaged host lifecycle and CLI/app
handoff. Run the shared core, independent Python REST fixture and platform/package
CI checks on the same source. Verify production dependency advisories and registry
signatures for both the frozen build and clean-installed CLI.

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
