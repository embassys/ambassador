# Human work queue

Status: current action view as of 2026-08-31

This page answers two questions: what needs a person, and what remains before a
release claim is honest. The [architecture PR backlog](architecture-pr-backlog.md)
owns task dependencies and completion evidence. The
[decisions-to-review](decisions-to-review.md) page keeps the detailed review
record.

## Human decisions and reviews

### Required before live central qualification

- [ ] A central owner must identify the exact DPoP commit and development
  deployment for
  [`embassys/agent2agent`](https://github.com/embassys/agent2agent). The
  inspected default branch and hosted routes still show the older bearer API.
- [ ] Complete I01 by inventorying the entire current REST, MCP, template, and
  event surface, tracing every flow impact, and updating gateway API clients,
  fixtures, and reviewed tests to the pinned latest server contract. Return
  material differences to ADRs 0023, 0025, or 0026 for review.
- [ ] Confirm the exact schemas and consent behavior of the new user-email and
  user-phone request templates. Approve one as the low-impact development E2E
  interaction instead of calendar only after the pinned contract is reviewed.
- [ ] Complete I02 by switching a fresh development identity to the pinned
  DPoP deployment and passing the full enrollment, protected transport,
  reissue, contact-request, message, reply, acknowledgement, crash, and
  artifact E2E flow with synthetic or disposable contact data.
- [ ] A central owner must publish and review the S01 red failure inventory in
  the central service repository. The gateway T03 and T04 inventories are
  already accepted. Gate A remains open until the central half is accepted.
- [ ] Central owners must supply the production issuer, API base and resource,
  MCP resource and endpoint, deployed schemas, proxy trust, signing and replay
  design, quotas, email behavior, and rollout dates.

### Required before provider support

- [ ] Provide a disposable authenticated environment and run the
  [Codex CX04 procedure](cx04-codex-manual-qualification.md) for every claimed
  platform.
- [ ] Provide a disposable authenticated environment and run the
  [Claude CL04 procedure](cl04-claude-code-manual-qualification.md) for every
  claimed platform.
- [ ] Decide whether Gemini remains part of the first stable connector scope.
  If it does, approve a new ADR only after a stable interface meets the
  structured-input, policy, sandbox, recovery, and hard-death containment
  requirements. ADR 0036 rejected the current candidates.

### Product decisions still open

- [ ] Approve an explicit local identity-reset interface for an unreadable
  gateway credential or uncertain revocation. Until then, the gateway must
  preserve the credential and fail closed.
- [ ] Approve Q03 preview publication only after Q01, Q02, and one real
  provider qualification pass. Public source approval did not approve a
  publish job or a support claim.
- [ ] Approve Q05 stable publication only after the requested providers and
  platforms pass Q04 combined qualification.

### Available, nonblocking review

- [ ] Review ADR 0034's Codex preview choices if desired. They were accepted
  under delegated judgment so CX02 and CX03 could proceed. A change would need
  a superseding decision and new evidence.
- [ ] Review the implementation judgments collected under the named sections
  in [decisions to review](decisions-to-review.md), especially the K03, CX02,
  CX03, and provider-specific sections. These reviews do not block current
  local fixture work unless a judgment is changed.

Windows is not an open release task. ADR 0033 deliberately deferred it. A
person may reopen it only by approving a new implementation and native
qualification plan.

## Engineering and test work

| Work | Owner | State | Next completion evidence |
| --- | --- | --- | --- |
| I01 complete server API and test refresh | Gateway and central teams | Server repository found; current revision, complete API inventory, and deployed schemas unpinned | Every REST route, MCP tool, template, callback or event, version, and deprecation is classified; affected flows, clients, fixtures, and tests agree with one pinned revision |
| I02 DPoP development switch and live E2E | Gateway and central teams | DPoP and new email/phone request templates reported; exact schemas and deployment unpinned | Fresh version 2 identity passes DPoP issuance, bearer rejection, protected REST and MCP, a synthetic contact-request flow, reissue, delivery, reply, acknowledgement, restart, and artifact tests without persisting contact data |
| S01 central red suite and review | Central team | Server repository located; reviewed red suite absent from inspected `main` | Central owner accepts the exact failure inventory |
| S02 REST enrollment and native MCP results | Central team | Pending S01 and Gate A | Central contract tests pass |
| S03 DPoP issuance and enforcement | Central team | Reported implemented, but exact revision, deployment, and enforcement evidence are unpinned | Bearer, wrong-key, replay, and proxy mismatch tests fail before dispatch |
| S04 leased delivery and idempotent acknowledgement | Central team | Pending S03 | Crash and lease tests redeliver one immutable message |
| S05 idempotent reply and terminal outcomes | Central team | Pending S04 | Lost reply response produces one outbound message |
| S06 reissue, revocation, rotation, and recovery | Central team | Pending S03 | Same-key and email-control recovery tests pass |
| S07 production-like staging | Central team | Pending S02 through S06 | Black-box tests pass through the real proxy and shared state |
| E01 gateway enrollment and DPoP qualification | Gateway team | Blocked on S07 | Node, Docker, packed install, and staging pass |
| E02 gateway message and crash qualification | Gateway team | Blocked on S07 | Every lease, reply, completion, and acknowledgement barrier passes |
| E03 soak and artifact scan | Gateway team | Blocked on E01 and E02 | Outage, quota, shutdown, and complete artifact scans pass |
| G05 remove Python-literal normalization | Gateway team | Blocked on native central results and qualification | One native structured path remains |
| G06 remove consuming poll fallback | Gateway team | Blocked on leased central delivery and qualification | One canonical leased receive path remains |
| G07 remove verbose transcript | Gateway team | Blocked on useful central errors and qualification | Option, code, tests, ADR exception, and development TODO are removed together |
| CX04 real Codex qualification | Human plus provider owner | Runner ready, not run | Real protocol, policy, history, recovery, packaging, and containment evidence passes |
| CL04 real Claude qualification | Human plus provider owner | Runner ready, not run | Real protocol, policy, history, packaging, and hard-crash evidence passes |
| GM01 replacement interface decision | Human plus provider owner | Blocked; current candidates rejected | A compliant stable interface and accepted ADR exist |
| Q02 connector operations guide | Documentation owner | Prepared, not a support claim | Update it with evidence from the first successful real provider run |
| Q03 connector preview | Release owner | Not approved and not ready | One qualified provider plus explicit preview approval |
| Q04 cross-provider soak | Release owner | Pending requested real-provider qualifications and Q03 | Mixed conversations, restarts, outages, and uncertainty pass without duplication or leaks |
| Q05 stable connector release | Release owner | Not approved and not ready | Q04 and explicit stable approval pass |
| R01 version 2 gateway release review | Release owner | Pending E01 through E03 and G05 through G07 | Docs, package, audits, platforms, and shipped behavior agree |

## Completed local work

Do not reopen these tasks unless their accepted contract changes:

- [x] T01 through T04 fixtures, harnesses, and reviewed gateway red suites
- [x] G01 through G04 local version 2 gateway implementation against fixtures
- [x] K01 through K04 provider-neutral connector fixtures, implementation, and
  fake-provider system tests
- [x] CX01 through CX03 Codex contract, fake tests, and adapter
- [x] CL01 through CL03 Claude contract, fake tests, lifetime monitor, and
  adapter
- [x] Q01 shared fake-provider regression matrix for implemented adapters
- [x] Q02 draft setup and retention guidance
- [x] Public source relocation to `https://github.com/embassys/ambassador`

These are local and fixture-backed results. They do not prove production
central behavior, real provider behavior, or release support.

## Feature-test checklist

Before making a support or release claim, a human reviewer should be able to
point to evidence for each row.

| Area | Required evidence | Current position |
| --- | --- | --- |
| Server contract | Pinned source commit, deployment identifier, exhaustive REST, MCP, template, and event inventory, generated schemas, and flow-impact report | I01 pending; attached API snapshot and inspected `main` show the older bearer-era surface |
| User-contact templates | Exact email- and phone-request schemas, consent and result behavior, synthetic contract tests, and approved low-impact E2E selection | Reported available on a newer server; identifiers and schemas must be confirmed by I01 before I02 uses them instead of calendar |
| Enrollment | Real email, issuance proof, token binding, lost response, restart | Fixture coverage only; I02 pending |
| Protected transport | Real TLS proxy URI, nonce, replay across replicas, bearer rejection | Fixture coverage only; DPoP is reported implemented but not live-qualified |
| Message custody | Lease expiry, immutable redelivery, reply, completion, acknowledgement | Fixture coverage only |
| Crash recovery | Every gateway, connector, provider, reply, and acknowledgement barrier | Fake process coverage; real central and provider runs pending |
| Provider policy | Real read-only and workspace-write behavior with no automatic grant | Codex and Claude manual runs pending |
| Provider continuity | Two turns in the same real session and safe missing-history behavior | Codex and Claude manual runs pending |
| Process containment | No provider descendants after normal stop, cancellation, or connector hard death | Fake coverage; real platform proof pending |
| Packaging | Empty-prefix install, native SQLite load, minimal files, no test controls | Local package tests exist; release artifact review pending |
| Data boundary | No content or credential in SQLite, logs, temp files, crashes, or packages | Local artifact scans exist; soak and real-run scans pending |
| Operations | Central outage, rate limits, mailbox pressure, token reissue, clean shutdown | E03 pending |

## Keep this queue current

Update this page in the same change that closes a listed gate or adds a new
human decision. Do not mark a task complete from a green fixture when its row
requires central staging, a real provider, a packed release artifact, or
explicit approval.
