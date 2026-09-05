# Delivery qualification

This strategy separates deterministic product behavior from third-party agent
behavior.

## 0.2.18 release candidate

On 2026-09-05, the clean-installed 0.2.18 candidate passed the remaining
Hermes and OpenClaw delivery matrix against `https://mcp.embassys.ai`.
The tarball SHA-256 was
`f8ab69e84187afe718f38a1755d4b8664bc266e020240b750c6e1df6234c9392`.
A fresh pack after the qualification-harness fixes produced the same bytes.
Reviewed central revision remained
`708f205bfaee5010eb86fcfae55967fb5d02071c`; the deployment does not expose its
revision.

| Provider | Mode | Action round trip | Result submissions | Session commands |
| --- | --- | --- | --- | --- |
| Hermes | Direct | Passed | 1 | Running reads and stopped metadata cleanup passed; provider deletion unsupported |
| Hermes | Webhook | Passed | 1 | Not applicable |
| OpenClaw | Direct | Passed | 1 | Running reads and stopped metadata cleanup passed; provider deletion unsupported |
| OpenClaw | Webhook | Passed | 1 | Not applicable |

Every run used disposable identities and an isolated provider configuration.
Registration, verification, encrypted restart, DPoP checks, emailed permission,
saved outbound intent, acknowledgement order, artifact scanning, mail cleanup,
and local cleanup passed. Webhook cases also passed the native authentication
and custody checks. These four runs did not request ACP human approval; the
combined Codex-to-Claude evidence below covers that flow.

Hermes direct used runner SHA-256
`374ee5d5f02bd55e7f180188d99f615404a16713b34588e2f4aebb7c21da1fb2`;
Hermes webhook used
`c76a0a9ba729eb18591316c05a5b85d53571a060a2886d667a6c3aeffceeb9f0`;
both OpenClaw modes used
`2fd191868b8edf181b71de8ac3c911fd1d4c24c7a0bbd3306ff4ca57d3480f32`.
The runner now configures Hermes MCP in both modes, expects only the action
message at the target webhook under the email-permission contract, and keeps
the provider gateway available while Ambassador's stopped-only session commands
run. Earlier attempts completed the action exchange but failed these later
harness assertions; fresh complete runs passed after correction.

The full local check passed 249 tests with six expected skips. CI run
`33957758524` passed all Linux, macOS, Windows, Docker, package, and audit gates.
The packed test now stops both gateway instances before removing state, including
after a failed assertion, and allows Windows state initialization to finish.
The approval deadline test leaves room for Windows process startup while keeping
the simulated human wait longer than both deadlines. These are test changes;
the release runtime and public CLI contract did not change during qualification.

The same 0.2.18 candidate then passed a fresh combined Codex-to-Claude run
using runner SHA-256
`2fd191868b8edf181b71de8ac3c911fd1d4c24c7a0bbd3306ff4ca57d3480f32`.
Its clean install resolved Codex ACP 1.10.0 / Codex 0.153.4 and Claude ACP
0.75.0 / Claude Agent SDK 0.3.257. The controlled harness initiated the request
and applied the disposable email decisions. Ambassador dispatched the saved
payload once with zero rejected action calls; real Claude submitted the
correlated result exactly once. Real Codex processed the permission outcome and
action response in one peer session. One ACP own-human email approval, both
agents' running session reads, stopped session deletion and forgetting,
acknowledgement order, verbose redaction, artifact scanning, mail cleanup, and
`clean` passed. Host Claude reported 2.1.261; the separate host Codex version
probe remained unavailable and did not gate its package-owned adapter.

## ADR 0056 combined Codex-to-Claude live qualification

On 2026-09-05, the combined live flow passed with real Codex and Claude against
`https://mcp.embassys.ai`. It used the same clean-installed candidate described
below, with tarball SHA-256
`815a533a84cb64cf2056a9d068c729ac67dcfd4ed89dafb1ab9d304d8e5965b7`.
The final runner SHA-256 was
`70301d4fd05badc9c4b64dfe0ec93ac6e598a3e9c3768275fdad6769125ed89b`.
Reviewed central revision remained
`708f205bfaee5010eb86fcfae55967fb5d02071c`; the deployment does not expose its
revision.

The installed package used Codex ACP 1.10.0 / Codex 0.153.4 and Claude ACP
0.74.0 / Claude Agent SDK 0.3.257. The separate host Claude command reported
2.1.261; the host Codex ACP version probe was unavailable and did not select or
gate the package-owned adapter. Codex used an isolated home with its existing
authentication and no API-key environment variables. Claude used its ordinary
home and existing Ambassador MCP setup.

The controlled harness initiated `request_permission` with an exact saved
payload and applied the disposable email decisions. Ambassador submitted one
action call with zero rejected attempts. Real Claude called
`submit_action_result` exactly once with the expected synthetic result. Real
Codex processed both the permission outcome and correlated action response in
one active peer session. This is a combined real-agent exchange; the initiating
MCP call was made by the harness, not an interactive Codex chat.

Registration, verification, encrypted restart, DPoP positive and negative
checks, the action catalog, Embassys email permission, and one ACP own-human
email approval passed. Both agents completed delivery before acknowledgement.
Running `sessions list`, normal `sessions show`, and verbose `sessions show`
passed for both gateways. Stopped session deletion and forgetting, repeated
`webhook-secret`, verbose startup redaction, artifact scanning, `clean`, mail
cleanup, and temporary-state cleanup also passed.

The first attempt completed the action round trip but failed the later
session-list check: the harness sent Codex's read to the default port occupied
by Claude. The runner now supplies each gateway's endpoint through the existing
private-control test override and checks session history while the gateways run.
It also waits for Codex's permission-outcome turn to complete before ending that
turn's human-approval check; gateway-side action dispatch alone is insufficient.
All 21 relevant CLI and qualification-runner tests passed before the final live
repeat. No production code, public CLI contract, or ADR changed for this repair.

## ADR 0056 storage, session reuse, and explicit outbound intent

On 2026-09-05, `pnpm run check` passed 255 tests: 249 passed and six
platform-specific or opt-in cases skipped. Linting, type checking, and the
production build passed. Coverage includes indexed encrypted paging beyond the
former store limits, byte quotas, validation before result consumption, receipt
capture across approval waits, bounded buffer drainage, peer isolation, separate
action completion, early result acceptance, dispatch replay refusal, repeated
retention batches, bounded history replay, and exact outbound intent across a
restart. Existing-state migration is deliberately absent.

The packed candidate SHA-256 was
`815a533a84cb64cf2056a9d068c729ac67dcfd4ed89dafb1ab9d304d8e5965b7`.
A clean npm install resolved Codex ACP 1.10.0 with Codex 0.153.4 and Claude ACP
0.74.0. The clean-installed live run passed against reviewed central revision
`708f205bfaee5010eb86fcfae55967fb5d02071c`; the deployment does not expose its
revision. The runner SHA-256 was
`4226c63cf480c84bd77306881cd22486aa407f25fda9f658d5d4267acb9d0e41`.

The live flow used two disposable identities, a controlled webhook requester,
and the deterministic ACP target. Registration, verification, encrypted restart,
DPoP positive and negative checks, the current action catalog, both human email
approval flows, acknowledgement order, and the action-result round trip passed.
The requester saved an exact payload before permission was granted, and
Ambassador issued exactly one matching action call. Artifact scanning, mail
cleanup, temporary-state cleanup, and `clean` passed. No central MCP request
was made. Live session commands were not exercised by this mock-provider run;
their current behavior is covered by the deterministic CLI tests.

Separate real-provider checks used two synthetic messages from the same remote
identity and required the second turn to recall an unpredictable marker supplied
only in the first. Each turn launched a fresh ACP process. All four retained
one provider session and recalled the marker:

| Provider | Observed ACP version | Context recall | Synthetic history cleanup |
| --- | --- | --- | --- |
| OpenClaw | 2026.8.2 | Passed using load | Delete unsupported |
| Codex | 1.10.0 | Passed | Deleted |
| Claude Code | 0.74.0 | Passed | Deleted |
| Hermes | 0.20.5 | Passed | Delete unsupported |

These checks used normal provider authentication and configuration, requested
no tools, and received no permission callbacks. Local temporary state was
removed. OpenClaw and Hermes retain their synthetic native history because
they do not advertise ACP deletion. The checks establish context continuity;
they do not force model compaction or replace the full real-provider delivery
matrix. `qualify:agents` now also requires second-turn marker recall and attempts
provider history cleanup.

The initial OpenClaw attempt exposed a restart failure in its advertised resume
path. Its installed bridge restores the ACP-to-gateway ledger mapping through
load, which the fixed production profile now requires. The older locked Codex
ACP 1.8.0 / Codex 0.152.1 runtime rejected the configured `gpt-6-astra` model;
the clean install above passed without changing provider settings. The existing
24-hour dependency-age policy and development lockfile remain unchanged.
Public adapter specifications remain the approved npm wildcards.

Central polling still consumes messages before local capture, and result
submission still has no idempotency key or outcome lookup. This change does not
claim to recover those uncertain server outcomes. The user deferred the ACP
approval-option mapping change. No release was published by this qualification.

## Email-only permission and inbox regression

On 2026-09-04, the deterministic central contract and Ambassador integration
were updated for ADR 0054. The flow proves that a new permission request creates
no grantor-agent message or Ambassador inbox item, the emailed confirmation GET
does not change state, `allow_once` produces the requester's
`permission_outcome`, and a second action call is refused after the single use.
The MCP catalog has no `respond_to_permission`; `get_inbox` contains only
unanswered action calls and unread action results. The live runner now performs
the same disposable-email sequence on its next controlled run.

ADR 0055 replaces automatic ACP approval. Deterministic coverage now holds the
provider request open, asks the local agent's own owner through
`get_human_input`, resolves it only from the correlated `human_input_response`
on `poll_messages`, maps acceptance to ACP `allow_once`, maps denial to
rejection, pauses delivery deadlines during the human wait, suppresses the
control response from provider prompting, and returns unrelated polled
messages to the normal relay before acknowledging them.

## Live session inspection and unified inbox regression

On 2026-09-04, the deterministic suite proved ADRs 0051 and 0052. Ambassador
encrypted a validated `action_response` before central acknowledgement, kept
it across a process restart, returned it once through `get_inbox`, and removed
it from later inbox responses. At that revision, the same tool also returned
pending permissions; ADR 0054 later removed that projection and left action
requests until their response operation succeeded. The database contained
neither the plaintext call ID nor the returned phone number. Separate tests
covered exact duplicate handling, conflicting results, malformed messages,
credential-shaped fields, identity binding, linked database files, and count
and byte limits.

The ACP fixture also sent an available-command catalog during delivery and
session history loading. Verbose startup recorded only its count, and verbose
session history omitted the catalog and its descriptions.

ADR 0053's deterministic cases kept the foreground process running while a
second CLI invocation listed sessions and loaded both normal and verbose
provider history. The same case proved that deletion still fails while the
process owns the lock. A delivery-order case held a direct delivery open and
proved that provider history loading waited for it to complete. Boundary tests
proved the private route requires the encrypted internal secret, rejects
browser Origin requests, and does not make Authorization valid on `/mcp`.
Separate coverage verified encrypted stable control-secret storage, fixed
platform paths, and cleanup inclusion.

The repository check passed 234 tests: 228 passed and six platform-specific or
opt-in cases skipped. Linting, type checking, and the production build passed.

## Clean Codex-to-Claude live qualification

The ADR 0055 own-human input candidate passed a fresh combined run on
2026-09-04 against reviewed central source revision
`708f205bfaee5010eb86fcfae55967fb5d02071c`. Its packed tarball SHA-256 was
`59d6114213a4aac63ea59b3cf34a7b50f7023d2893c4def7d907cdc67350d76b`,
and the runner SHA-256 was
`6d9de51f592d0eacda995d02db854d0860ab012fc863d7be9101523b72d08a64`.
The diagnostic probes observed Codex ACP 1.8.0 and Claude Code 2.1.261.

The run used `POST /api/get_human_input` for a provider permission request,
answered `Allow once` through the disposable owner's email, received the
correlated `human_input_response`, and resumed the open ACP request. One of the
two providers requested approval; the other completed its turn without an ACP
permission callback. The Embassys `get_phone_number` permission still used the
separate grantor email flow. Codex issued one accepted action call, Claude
submitted exactly one successful result, and Codex received it. Registration,
verification, encrypted restart, DPoP positive and negative checks, the
six-action catalog, acknowledgement order, every public CLI command, artifact
scan, mail cleanup, and temporary-state cleanup passed. No central MCP request
was made.

On 2026-09-04, the completed ADR 0050 candidate passed a clean packed-artifact
Codex-to-Claude flow against the deployed service. The tarball SHA-256 was
`26e821a951afd5d1c9a9d4e54ba6af333f6f0cb011b33373b628f4dac870d237`,
and the exact runner SHA-256 was
`fcefba2f0574da7b8189fbc52c522f853b75fbd6e96cdef4f9547bb3703b102b`.
The clean install resolved the current public adapters at
`@agentclientprotocol/codex-acp` 1.9.0 and
`@agentclientprotocol/claude-agent-acp` 0.74.0. Claude Code 2.1.260 was
observed behind the Claude adapter. A separate `codex-acp` 1.8.0 command on
the host was only a diagnostic probe; delivery used the package-owned 1.9.0
adapter.

The runner explicitly removed `OPENAI_API_KEY` and `CODEX_API_KEY` for this
qualification, so the Codex side proves native subscription authentication.
The fixed Codex profile also preserves either variable when a user deliberately
configures API-key authentication; Claude inherits its normal provider
environment and therefore supports both provider authentication choices too.

The runner registered and verified two new disposable identities, restarted
both gateways from encrypted state, and passed the DPoP positive and negative
matrix. The deployed server differed from its public source revision
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`: `request_permission` returned
the bounded `already_granted` and `decision` fields, emailed the human grantor,
and did not queue a `permission_request` to Claude. The runner proved the
pending-permission projection, applied `accept` through the disposable email
decision flow, and observed the current `permission_outcome` notification with
`granted: true`.

Codex received that outcome through its normal provider-configured Ambassador
MCP and issued one valid `call_action` with zero rejected attempts. Claude
received the resulting `action_call`, submitted exactly one correlated
synthetic phone result, and Codex received the successful `action_response`.
Each gateway acknowledged central only after successful local completion. The
live six-action catalog and schema digests matched the fixtures; no DPoP nonce
or central MCP request was observed.

The same run proved persistent per-message sessions, result-based retirement,
`sessions list`, normal and verbose `sessions show`, `sessions delete`,
`sessions forget`, stable repeated `webhook-secret`, redacted `start
--verbose`, ordinary `start`, and `clean`. Artifact scanning, mail cleanup,
temporary-state cleanup, and credential redaction passed.

That live artifact used 0.2.16 package metadata before the separate release
approval. The final 0.2.17 release also contains the Windows process-tree and
test-handle cleanup found by the pull-request gates. Both Windows check lanes
then passed, as did every Linux, macOS, Docker, package, audit, and signature
gate on the pull request and `main`.

GitHub OIDC trusted publishing released 0.2.17 with the npm `latest` tag. The
registry tarball SHA-256 is
`4b07256f5c72fff01decb81a2e18886a52cb271c70c8e3eb4539bdc30c771d0e`;
its npm integrity is
`sha512-eIZCR2d1UBK2jWzCxlIr/Ya43aXdeX0xI8z8BHEFHJCcig4ojKQhQDmsCcC11L2F4zxkt3Ero4UNXwLmslFe0A==`.
A fresh registry download passed the clean-installed packaged REST enrollment,
delivery, acknowledgement, cleanup, and artifact-scan lane.

This is a combined direct-delivery qualification, not an interactive chat
transcript. The controlled runner invoked `request_permission` and acted as the
human who clicked the disposable email decision. Codex continued the granted
request, while Claude handled the inbound action and Codex handled both
correlated central responses.

## ADR 0049 live Claude and Codex repeat

On 2026-09-04, the post-ADR 0049 source candidate ran against the deployed
service with Claude Code 2.1.260 and the package-owned Codex ACP adapter 1.8.0.
The packed candidate SHA-256 was
`ea7a0252b038037253fca249188f2715e9f1ef941f15794d6f0d6cee21a3e2c5`.
The live runner SHA-256 was
`ee95fde55b1625bb184b81dc218c0d5bd0a31bc2d9883bfe5622192e1738c79a`.

Real Claude passed the complete live-central direct flow twice consecutively.
Real Codex passed the same flow against the same archive. Every final run
registered and verified two disposable identities, reloaded encrypted state,
passed the DPoP positive and negative matrix, granted the synthetic permission,
submitted exactly one correlated synthetic phone result, delivered the action
response, and preserved local-completion-before-acknowledgement ordering. The
live six-action catalog matched its recorded schemas. No DPoP nonce or central
MCP request was observed. Artifact scanning, Mailosaur cleanup, and temporary
state cleanup passed.

The initial Claude attempts found two concrete defects before the final passes.
First, Claude rejected the generic `mcp__*` allow rule because it does not match
a full `mcp__server__tool` name. The bridge now uses Claude's non-interactive
permission bypass while retaining `--tools ""`, which keeps built-in filesystem
and shell tools unavailable. A local exact-tool probe confirmed the configured
MCP call before the live repeat. Second, the runner moved the target MCP port
after its encrypted-state restart and did not prepare Claude's provider entry
again. The runner now preserves port 8787 for an ordinary Claude home and
prepares provider MCP configuration after both starts.

This installation keeps its subscription login in macOS Keychain and cannot
authenticate after `HOME` is replaced with a copied directory. The runner now
supports the ordinary home for that native authentication case without
rewriting provider configuration. It still supports owner-only isolated homes
for authentication methods that work in a copy.

These runs use the repository's controlled webhook requester and one real
direct target per run. They prove both real direct-agent paths and the complete
central round trip; they are not a shared interactive Claude-to-Codex chat.

## Provider-configured Claude bridge source qualification

On 2026-09-04, the current source removed the Claude-specific authentication
preflight. The built-in bridge now lets the installed official CLI apply its
native authentication and organization policy. The fixed Claude profile alone
inherits Ambassador's bounded process environment; every other profile keeps
its compiled allowlist. ADR 0049 subsequently changed Claude to normal provider
MCP configuration so resource-backed actions can use configured tools. The
unattended prompt keeps no built-in tools, no session persistence, and bounded
provider output.

The repository check passed 204 tests: 198 passed and six platform-specific or
opt-in cases skipped. Linting and type checking passed. Regression cases prove
that the bridge makes no separate auth invocation, preserves representative
native authentication environments, rejects inherited-environment bounds and
invalid names, loads normal configured MCP tools without safe or strict
isolation, uses the provider's non-interactive permission bypass rather than a
non-matching generic MCP wildcard, and does not reflect provider failure
details. The live runner now
configures Ambassador through Claude's provider configuration and requires the
real background turn to submit its result automatically. The subsequent
real-provider results are recorded above. Published-release evidence remains
separate from source-candidate qualification.

## Ambassador 0.2.15 candidate

On 2026-09-04, the byte-final 0.2.15 candidate added the encrypted local
unanswered-action inbox and completed the ADR 0047 reliability cutover. It
replaced the Claude adapter dependency with Ambassador's built-in ACP v1
bridge over the official installed `claude` CLI, retained the package-owned
Codex adapter, exposed one stable MCP tool catalog across enrollment, and kept
the MCP server available when a direct agent or webhook failure paused its
relay. No Anthropic API credential is accepted or required. The tarball
SHA-256 was
`88e17715db34e72615f17bc325e0cd2aa4cd49e15661a3d289d4ad3ea6302fe3`,
and its SRI was
`sha512-3H72E9UG9G1jkxsM/rdSxxGfN8ZK+QGHYyNIbm+5ppHYpLwu67djkzT+nZN4iCdyFnHNgDy8QgdJAZd6udgcXQ==`.

The Node 26.7.0 repository check passed 202 tests: 196 passed and six
platform-specific or opt-in cases skipped. Linting and type checking passed.
A clean installation of the packed candidate resolved the fixed Codex adapter
and Ambassador's own Claude bridge, then passed the installed-CLI REST
enrollment, stable catalog, webhook delivery, acknowledgement, cleanup,
restart, and artifact-scan test. The source signature audit verified all 76
registry packages. The packed-install signature audit verified all 43 registry
packages; only the unpublished top-level 0.2.15 candidate lacked registry
metadata. The package contained neither the removed Claude adapter dependency
nor qualification trace or multi-instance hooks.

The real-agent qualification used Codex CLI 0.149.0 and Claude Code 2.1.260 in
the same user-driven flow. Both agents registered and verified disposable
identities through their normal chats without reconnecting to refresh tools.
Codex requested `get_phone_number`; Claude listed the pending permission and
granted it. Codex sent the action call. Ambassador's Claude bridge processed
the central message with the existing `claude.ai` login and retained it in the
encrypted pending-action inbox. Claude then listed the pending action and
submitted a synthetic phone number. Central accepted the correlated result,
and Codex received the matching successful `action_response`. The two
verification messages and all temporary state were deleted after the run.

An initial Claude bridge launch showed that the restricted child environment
also needs the ordinary `USER` or `USERNAME` operating-system context; the
registry and regression tests now preserve it without forwarding Anthropic
API-key or token variables. The run also reproduced a central liveness defect:
an empty 30-second message poll can exceed the client's 40-second allowance,
and an aborted response can strand a message that central already marked
delivered. Ambassador now reserves ten seconds beyond the requested hold, but
listener-pool bounds, delivery leases, disconnect recovery, and redelivery are
server work recorded in [Central service follow-ups](central-follow-ups.md).
The successful round trip required retries around that live central behavior;
it did not add a client fallback.

PR 30 passed all seven required checks and merged as
`d3bebc73416c27bf7500a645b7ce15ccfb9fdd95`. Main-branch run `33823471270`
repeated the Linux, macOS, Windows, package-install, production vulnerability,
signature, Windows ACL and command-shim, and Docker central-fixture gates. Its
OIDC job published `@embassys/ambassador@0.2.15`, and the npm `latest` tag
resolves to 0.2.15.

The artifact downloaded from npm's published tarball URL had registry SRI
`sha512-nTqGHCnCaNBUL7xyPHqOxwz/vm0ZnOx6mKombI4BJ6BBBZJ3Sa/ZwWa+GH7gv1XTR5x+UhA12tavUeGqZIdeSA==`,
registry SHA-1 `e5d84b5250703a06546567fc7067e6936943861a`, and tarball
SHA-256 `95cff931c82eec5e4f36407693bc0746ab4468955741e79ca1e258a3626fe611`.
Its extracted file tree was identical to the qualified candidate; npm's
archive encoding accounts for the archive-level digest difference. A clean
registry installation passed the installed-CLI REST enrollment, stable tool
catalog, webhook delivery, acknowledgement, cleanup, restart, and artifact
scan. Its signature audit verified all 44 packages with no invalid or missing
entry.

## Pending-action inbox source qualification

On 2026-09-03, the current source added the encrypted local
`list_pending_action_calls` view without adding a central route. The fixture
round trip proved capture before delivery and acknowledgement, listing after an
Ambassador restart, correlated result submission, and removal only after a
valid central success. Unit cases proved authenticated encryption, identity
binding, tamper and link rejection, exact duplicate handling, record and byte
bounds, and absence of plaintext call IDs and payload markers in SQLite.

The repository check passed 196 tests: 190 passed and six platform-specific or
opt-in cases skipped. Linting and type checking passed. A clean installation of
the packed source artifact also passed the installed-CLI REST enrollment,
authenticated tool catalog, webhook delivery, acknowledgement, cleanup,
restart, and artifact scan. This is source evidence, not a published-release or
real-agent qualification record.

## Ambassador 0.2.14 candidate

On 2026-09-03, the byte-final 0.2.14 candidate added package-owned Codex and
Claude Code ACP adapters, actionable startup and direct-delivery failures,
agent-specific MCP setup guidance, intention-oriented tool descriptions, and
the read-only `list_pending_permission_requests` projection. The central REST,
DPoP, webhook, credential, and local-state formats are unchanged. The tarball
SHA-256 was
`7dada5440958b0f7fabb58c2cb4735f428a993af45043c3c82dc7ec5b10059d2`,
and its SRI was
`sha512-lE3GBkC9BSM+mTUceWo2I4NIBQou1aWTSSfW0LoN1y1vPbrVrM3WnuILOhe3Lps2LeBpALfV/LKUYOtAkxjABQ==`.

The Node 26.7.0 repository check passed 191 tests: 185 passed and six
platform-specific or opt-in cases skipped. Linting and type checking passed.
A clean installation of the packed candidate installed both exact adapter
dependencies, resolved their validated package-owned entrypoints, and passed
the installed-CLI REST enrollment, pending-tool catalog, webhook delivery,
acknowledgement, cleanup, restart, and artifact-scan test. The production
vulnerability audit found no known issue. The source signature audit verified
all 172 registry packages. The packed-install audit verified 140 registry
packages; only the unpublished top-level 0.2.14 candidate lacked registry
metadata.

The embedded adapters do not remove the need for an installed and signed-in
Codex or Claude Code provider. They remove the separate ACP-adapter install and
the unhandled missing-adapter process failure. The new pending-request view is
derived from the existing `get_my_permissions` response and introduces no
second queue or central route. Because the central and delivery protocols are
unchanged, the 0.2.12 live-central evidence and current real-agent evidence
remain applicable.

## Ambassador 0.2.13 candidate

On 2026-09-03, the byte-final 0.2.13 candidate removed the npm engine upper
bound. Its public range is `>=24.19.0`. Runtime source and dependencies are
unchanged from 0.2.12. The tarball SHA-256 was
`526ac63bb0743e20b430e350c3c0000aced4137b09b9688c9ccbda02dc8056f4`,
and its SRI was
`sha512-5zxbG8Hi8jtxPVL5FYt7mTz4yS3c6Bmtv7JpiVFnxp1MGAAWiQgmHB0S8tAgXujBObCvuqOZWjmg163qud8zmw==`.

The Node 26.7.0 repository check passed 184 tests: 178 passed and six
platform-specific or opt-in cases skipped. Linting and type checking passed.
A clean npm installation of the packed candidate produced no engine warning
and passed the installed-CLI REST enrollment, delivery, acknowledgement,
cleanup, restart, bootstrap-catalog, and artifact-scan test. The installed
command also completed `clean`, bound its MCP endpoint, and shut down under
Node 26.7.0. The same command completed `clean` and bound the endpoint under
the reported Node 26.6.0 runtime.

The production vulnerability audit found no known issue. The signature audit
verified all 53 registry packages. Because no runtime source, dependency,
central contract, delivery profile, or state format changed, the 0.2.12
live-central evidence and current real-agent evidence remain applicable.

## Ambassador 0.2.12

On 2026-09-03, the byte-final 0.2.12 candidate added the local-only
`ambassador clean` command without changing central REST or agent delivery.
Its tarball SHA-256 was
`287a3b4907e19d07bbc11974bb3cefdf55589d4a37b01f27474d4b82c01b93a0`
and its SRI was
`sha512-3RMGiq5A7GCO4qbZx7MWe82PwhaU/b+HnAg+Zs/21K64GdmAbNtjD+bqbv3UZT3dzPkK6m8X/LmNLwxY33QJDQ==`.

The Node 24.19.0 repository check passed 184 tests: 178 passed and six
platform-specific or opt-in cases skipped. Linting and type checking passed.
A clean external install passed the current REST fixture, real enrollment,
local cleanup, restart to the three-tool bootstrap catalog, artifact scanning,
and the production vulnerability audit. The signature audit checked 21
packages and verified the 20 registry dependencies. The unpublished candidate
was the only item without registry metadata.

The same tarball passed the controlled live-central run with deterministic
webhook and ACP targets. The run created and verified two disposable Mailosaur
identities, reloaded encrypted state after restart, and passed the Bearer plus
DPoP positive and negative cases. It verified the deployed six-action catalog,
the correlated permission and action-result round trip, local completion before
central acknowledgement, zero central MCP requests, artifact scanning, mail
cleanup, and temporary-state cleanup. The server did not request a DPoP nonce.
The qualification runner SHA-256 was
`ba71e8e736e3c1ef2705062befb16294e79a24488e4163127b46d57e1ca0f96f`.

The release does not change an agent profile, ACP handling, webhook delivery,
or the central client. The current real-agent evidence remains the 0.2.10
Hermes and OpenClaw four-mode matrix, the earlier Codex direct pass, and the
published 0.2.11 Claude Code direct pass recorded below. Windows release lanes
cover the clean command and installed package, but individual real-agent
Windows claims still require their own qualification.

PR 26 passed all seven required checks and merged as
`5ee0ea03dacf88ad9fbc260587d5c9daf273212b`. Main-branch run `33782469108`
repeated the Linux, macOS, Windows, package-install, audit, and Docker
central-fixture gates. Its OIDC job published
`@embassys/ambassador@0.2.12`, and the npm `latest` tag resolves to 0.2.12.

The artifact downloaded from npm's published tarball URL had registry SRI
`sha512-0DyBFNwTntRvk1YdlNSppqrtzvWy+T07uQL0VueLA9S249XeEYpOgoOXKOjkmt9bBG70dVmVWkM1bOnynkcnTw==`,
registry SHA-1 `ec23fb8c6f5859604e7131672ed1730cd404ec32`, and tarball
SHA-256 `089a0555c9a70e2dd954137756d621548020a593705cc45edeac91ffa8b71a45`.
Its extracted file tree was identical to the qualified candidate. A clean Node
24.19.0 registry install exempted only the newly published top-level 0.2.12
package from the 24-hour maturity window. The transitive dependency policy
remained strict. The production vulnerability audit found no known issues, and
the signature audit verified all 21 packages with no invalid or missing entry.
The installed registry CLI passed the enrollment, cleanup, restart, and
bootstrap-catalog E2E.

## Ambassador 0.2.11

On 2026-09-03, the byte-final 0.2.11 candidate passed the complete
live-central correlated-result webhook flow with OpenClaw and Hermes on macOS
26.5.2 arm64 and Node 24.19.0. Both runs used candidate SHA-256
`3cf828e32f8942e7a1d670865ecb2c55e138f63217d7342c1c2bb2c99d3dcd11`
and SRI
`sha512-kAtceesTXpWX+4i9EnDCBfystNTQZBeFWEAdE0UW73KpffgWmA3B0JWV9PIzk8CzQIpXk+ACGv5J4Mw9vZtV6Q==`.
The live runner SHA-256 was
`e15ec9ca725e2f9a3fad11982a357ba634f6920ddda6cd9a35f3a78696af05c8`,
and the reviewed central source revision was
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`.

| Agent | Version observation | Webhook result |
| --- | --- | --- |
| OpenClaw | `2026.8.2` | passed through native `/hooks/agent` |
| Hermes Agent | version probe unavailable | passed through canonical bearer and HMAC V2 route |

Each run created and verified two disposable Mailosaur identities through
their local Ambassador MCP endpoints, restarted Ambassador, reloaded the
encrypted credential, webhook secret, and delivery profile, and exercised the
live REST and DPoP contracts plus the deployed six-action catalog. The
controlled requester requested `get_phone_number` permission. The real target
model called `respond_to_permission`, then called `submit_action_result`
exactly once with the correlated call ID and approved synthetic phone result.
The requester received the matching `action_response`. Local custody preceded
each central acknowledgement.

OpenClaw used its built-in agent hook with the fixed `main` agent, isolated
session, disabled announcement, bearer authentication, and the central message
ID as its idempotency key. Ambassador validated OpenClaw's documented `200`
admission response with a bounded run ID. The packed artifact contained no
Ambassador-specific OpenClaw plugin, and the runner installed none. A `200`
was treated as admission only; the run continued until the real model made both
MCP calls and the requester received the final response.

Hermes retained the complete canonical body and HMAC V2 contract. Its bounded
version probe returned `unavailable`, which did not skip delivery. This was the
same locally installed authenticated Hermes setup previously observed as Agent
0.20.5, but the current pass rests on model execution and MCP results, not that
version value.

Two preliminary OpenClaw attempts reached native-hook custody and central
acknowledgement but ended at the bounded permission-model wait without an MCP
call. Safe OpenClaw run metadata classified both model runs as provider
authentication failures. The disposable OpenClaw home had its own config and
databases but was missing the separate owner-only backend authentication used
by its configured model. A newly copied isolated home that included that
backend configuration passed without an Ambassador code change. No prompt,
message body, provider output, or credential was logged or retained.

This setup failure is distinct from the 0.2.10 receiver timeout described
below. That older receiver accepted the request and then lost detached model
work when the request-scoped OpenClaw lease drained. Native `/hooks/agent`
owns model scheduling and removes that plugin lifecycle. It is also distinct
from the intentional wait after an Ambassador restart: an aborted local
30-second poll may remain active at central, which has no lease or redelivery,
so the qualification lets it expire before polling again.

The Node 24.19.0 repository check passed 183 tests: 177 passed and six opt-in
lanes were skipped as designed. Type checking and linting passed. A clean
tarball install passed the installed-CLI REST E2E and production vulnerability
audit. The dependency signature audit verified 29 registry packages and 22
attestations; the unpublished local candidate itself had no registry artifact
to verify. Both live artifact scans passed. The runner deleted captured mail
and temporary Ambassador state, and the owner-only OpenClaw and Hermes
credential copies were removed after their runs. The normal provider homes
were not changed.

PR 23 passed all seven required checks and merged as
`227538f5a81977467ad59482bae1fda571d6480a`. The main-branch run repeated the
Linux, macOS, Windows, package-install, audit, and Docker central-fixture gates,
then published `@embassys/ambassador@0.2.11` through npm OIDC. At publication,
the npm `latest` tag resolved to 0.2.11.

The artifact downloaded from npm's published `dist.tarball` URL had registry
SRI
`sha512-Tm8BxWFtsOso+Ns52bhxjI4VyEawUITlWF9qVcFlUK7mM+aaBmMYtUXiJwWum5TeUsLCM/zFRszP+dMAxTMO9A==`,
registry SHA-1 `184715279a4251f025c5fe438b08dedc7cd17816`, and tarball
SHA-256 `bca6d939b5c7faef975e3bb67b9c5f619d14cebe86a13b3b6f2341242be83d4c`.
Its extracted file tree was identical to the byte-final candidate used by both
live runs; npm's archive encoding accounts for the archive-level digest
difference. A clean Node 24.19.0 install passed the installed-CLI REST E2E and
production vulnerability audit. The registry-artifact signature audit verified
29 packages and 22 attestations with no invalid or missing entries.

## Claude Code direct with published Ambassador 0.2.11

On 2026-09-03, the actual published `@embassys/ambassador@0.2.11` registry
artifact passed the complete live-central Claude Code direct flow on macOS
26.5.2 arm64 and Node 24.19.0. Its registry SRI was
`sha512-Tm8BxWFtsOso+Ns52bhxjI4VyEawUITlWF9qVcFlUK7mM+aaBmMYtUXiJwWum5TeUsLCM/zFRszP+dMAxTMO9A==`,
its registry SHA-1 was `184715279a4251f025c5fe438b08dedc7cd17816`,
and its tarball SHA-256 was
`bca6d939b5c7faef975e3bb67b9c5f619d14cebe86a13b3b6f2341242be83d4c`.
The installed CLI first passed the current REST fixture. The live runner
SHA-256 was
`ba71e8e736e3c1ef2705062befb16294e79a24488e4163127b46d57e1ca0f96f`,
and the reviewed central source revision was
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`.

The fixed `claude-agent-acp` adapter was 0.73.0 and its official bundled Claude
Code executable reported 2.1.257. The separately installed host Claude Code
CLI reported 2.1.259, but the fixed adapter used its bundled executable.
Version observations did not gate the run. Direct registration used exact MCP
client name `claude-code`, ACP v1 required exact agent name
`@agentclientprotocol/claude-agent-acp`, and Ambassador MCP was injected into
the ACP session.

The real model granted the synthetic `get_phone_number` permission and called
`submit_action_result` exactly once with the correlated call ID, success
status, and approved synthetic result. The requester received the matching
`action_response`; local direct completion preceded central acknowledgement.
Encrypted state reload, live REST and DPoP behavior, the deployed six-action
catalog, the artifact scan, and Mailosaur cleanup passed. The isolated
owner-only Claude configuration was removed after the run, and the normal
Claude home was unchanged. No credential, identity, code, prompt, message body,
or provider output was recorded.

## Deferred Antigravity evaluation

On 2026-09-03, authenticated Antigravity CLI 1.1.25 connected to a temporary
Ambassador MCP probe with exact client name `antigravity-client`, reported
version `v1.0.0`, and made one real-model tool call. This proved the local MCP
client path only; it did not prove direct delivery.

A separately obtained Antigravity ACP server completed ACP v1 initialization
with exact agent name `antigravity-acp` and reported version
`agy_acp_server_20260818_01_RC01`. The archive SHA-256 was
`f122ca7e7030a27f9649da4cf1a7d80e12c48c5f6118ff35affc34d56cbf83dd`.
Session creation then failed in the authentication phase because the ACP server
used separate credential state and did not reuse the authenticated `agy`
configuration. No delivery prompt or Ambassador MCP result call occurred.

The normal Antigravity MCP configuration was restored byte-for-byte. Temporary
state was deleted, and no credential, prompt, message body, or provider output
was retained. ADR 0043 defers Antigravity and removes the Gemini CLI profile;
neither is part of the current qualification matrix.

## Local clean command

The deterministic CLI suite creates central-credential, webhook-secret,
delivery-profile, journal, temporary, nested, and symbolic-link residue inside
an isolated state directory. `ambassador clean` removes it while leaving an
external provider file unchanged. A second call succeeds with the same empty
result. A separate case holds the Ambassador process lock and proves cleanup
fails without removing the stored profile.

The clean-installed package lane performs a real fixture enrollment, stops the
gateway, runs `clean`, and restarts the installed CLI. The restarted MCP server
exposes only the three bootstrap enrollment tools. Windows runs the same packed
test and also covers the installed command shim.

On 2026-09-03, the source candidate passed linting, type checking, and the full
Node 24.19.0 repository suite: 184 tests, 178 passed, six opt-in or
platform-specific cases skipped, and zero failures. A clean installation of
the packed candidate passed the REST fixture enrollment, local cleanup,
bootstrap restart, and production vulnerability audit on macOS arm64. The
pull-request package lane remains the cross-platform proof.

## Ambassador 0.2.10

On 2026-09-03, the byte-final 0.2.10 candidate passed the complete live-central
matrix for the locally installed, authenticated Hermes and OpenClaw agents on
macOS 26.5.2 arm64 and Node 24.19.0:

| Agent | Observed version | Direct | Webhook |
| --- | --- | --- | --- |
| Hermes Agent | `0.20.5` | passed | passed |
| OpenClaw | `2026.8.2` | passed | passed |

The same clean-installed tarball was used in all four cases. Its SHA-256 was
`6517b01ce08eb30aed7b6bfbe82bdb6cc9db65bec04bf676903fb2d4d179e15c` and
its SRI digest was
`sha512-F+9tpCZR1EOXVTxTY5Vut/+TMpj1uj3HpbtR6vuYso0b/qu71zZMS3ZM9FA6v06UmmKxB7y6sQ4hyNYLX2Dzwg==`.
The live runner SHA-256 was
`ad9818a70514829c839c24ce3a6936341b623c98061f2d1c8e7fa96b92309259`,
and the reviewed central source revision was
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`.

Every case created two disposable Mailosaur identities, registered and
verified them through their local Ambassador MCP servers, and registered the
real target with exact MCP client information `mcp` / `0.1.0`. Each case then
proved encrypted credential and delivery-profile reload after an Ambassador
restart, production REST and DPoP behavior, the deployed action catalog, a
real-model permission decision, and a correlated synthetic action result. The
target called `submit_action_result` exactly once with the supplied call ID.
The requester received the matching final response, and local acceptance or
completion preceded the corresponding central acknowledgement.

Direct delivery launched each installed ACP agent, initialized ACP v1 with the
fixed agent name, injected Ambassador MCP, and observed the real model's two
required MCP calls. Webhook delivery used the internally generated encrypted
secret, bearer authentication, and HMAC V2. Hermes used its generic webhook
route. OpenClaw used the shipped `embassys-ambassador` receiver, returned
custody before model execution, and continued until the real model completed
both MCP calls. Report and state scans passed. Mailosaur messages, temporary
Ambassador state, and owner-only provider credential copies were removed; the
normal provider homes were not changed.

The observed agent versions are evidence, not compatibility gates. The same
candidate also passed deterministic registration and ACP tests with arbitrary
reported version strings while retaining exact MCP client names, ACP v1, and
fixed ACP agent names.

The safe failure record for this qualification is:

- Two Hermes webhook attempts ended with `mail_timeout` after central accepted
  registration but before Mailosaur delivered the verification message. No
  Hermes dispatch, model execution, or MCP invocation occurred. A later run
  passed unchanged, classifying these as transient central/email delivery
  failures rather than Hermes webhook failures.
- The first isolated OpenClaw direct attempt omitted the authenticated backend
  credential used by that installation. ACP started, but provider
  authentication failed before an MCP call. Supplying an owner-only isolated
  copy made the unchanged flow pass; the normal OpenClaw and provider homes
  remained untouched.
- The first OpenClaw webhook receiver returned `2xx`, transferring custody and
  allowing central acknowledgement, but its detached model task inherited the
  HTTP request's released OpenClaw work lease and failed with the safe class
  `GatewayDrainingError`. This was the model timeout: the message had reached
  OpenClaw, but no model or MCP call ran. The receiver now places accepted
  messages in a bounded, memory-only queue serviced outside the request
  lifecycle. The final live run proved that queued model work and both MCP
  calls complete.
- Restarting Ambassador aborts its local long poll, but the already-issued
  30-second central poll can remain active server-side. Starting the next poll
  immediately can let the abandoned request consume a message because central
  has no lease or redelivery. The qualification runner therefore allows that
  poll to expire before continuing. This accounts for the intentional quiet
  interval after restart and is distinct from an agent model timeout.

The full repository check passed 184 tests: 178 passed and six opt-in lanes
were skipped as designed. Type checking and linting passed. A clean package
install passed its installed-CLI REST E2E and webhook-secret CLI checks. The
production vulnerability audit found no known vulnerabilities; the signature
audit verified 20 registry packages and 13 attestations with no invalid or
missing entries. Docker was unavailable in the local environment, so the
containerized central-fixture lane remains a required pull-request check.

PR 21 passed all seven required checks and merged as
`cf5c5c4f889439d4dc08fb77839ce70891882632`. The main-branch run repeated the
Linux, macOS, Windows, package-install, audit, and Docker central-fixture gates,
then published `@embassys/ambassador@0.2.10` through npm OIDC. At publication,
the npm `latest` tag resolved to 0.2.10.

The artifact downloaded from npm's published `dist.tarball` URL had registry
SRI
`sha512-QPSP6/qDLX7U9sZZ69Ztmo1cEMKnircXlMSUEpPXbsx/H/2Cr4aU7S35zJ7neNVH4ETamL/JbG8hL0HGeTlO5Q==`,
registry SHA-1 `e2193d64d27d8726aff241906412ff7484caaaa3`, and tarball
SHA-256 `eb25c9d699ec580cf9b5fab0fbd4c8921c1607c2e7c407e59edbb9cecd87ee9d`.
Its extracted file tree was identical to the byte-final candidate used by the
four live runs; npm's archive encoding accounts for the archive-level digest
difference.

A clean Node 24.19.0 install of that registry artifact passed the installed
CLI REST E2E. The installed `ambassador webhook-secret` command created and
returned one stable value, and a forbidden option failed closed. The installed
capability registry matched all five client names present in that historical
artifact with a deliberately non-release version string. Installed direct
delivery completed ACP v1 when a
mock returned the exact agent name and a different reported agent version. The
registry-artifact audit found zero vulnerabilities, 20 verified registry
signatures, 13 verified attestations, and no invalid or missing signatures.

## CI delivery suite

CI uses the independent local central fixture plus two test targets. It does
not require a model account, network access, email delivery, or production
central.

### Mock webhook receiver

The receiver records bounded metadata and validates:

- the fixed webhook contract selected by the matched capability profile;
- the complete canonical Hermes body with bearer and HMAC V2 authentication;
- the OpenClaw native agent body, fixed `main` agent, isolated session, disabled
  announcement, bearer authentication, and no HMAC-only headers;
- matching request and idempotency IDs where each contract requires them;
- retries before acceptance and no local redelivery after acceptance;
- central acknowledgement only after a 2xx response; and
- shutdown, timeout, duplicate, malformed-response, and capacity behavior.

Test failures may report a case name and safe status. They must not print the
message, payload, secret, signature material, or request headers.

### Mock ACP v1 agent

The mock is a small NDJSON ACP v1 peer controlled by the test. It validates:

- initialize and capability negotiation;
- new-session, retry resume, load, close, and delete behavior;
- an empty ACP `mcpServers` array with tools loaded from provider configuration;
- one complete-message prompt with fixed untrusted-input instructions;
- target-side `submit_action_result` and correlated `action_response` delivery;
- normal terminal completion and acknowledgement order;
- pre-dispatch startup failure;
- `allow_once` permission selection and positive fallback;
- malformed output, overflow, timeout, cancellation, child exit, and cleanup;
- session metadata bounds, non-action and action-result retirement, 30-day
  cleanup, every session command, and verbose redaction; and
- no automatic replay after an uncertain prompt dispatch.

The mock must run without a shell and expose deterministic barriers so tests can
place crashes before and after every external-effect boundary.

### Shared cases

Both modes run the same queue, body-size, batch, deadline, concurrency,
singleton, graceful-shutdown, restart-loss, and forbidden-marker scans. SQLite
and the delivery profile must remain free of message content and secret values.

Registration cases also prove:

- exact known `clientInfo.name` values select only their fixed profile while
  reported client versions do not gate registration;
- unknown, ambiguous, disabled, and incomplete profiles return
  `unsupported_agent` before state or a central call;
- supplying a delivery object cannot bypass profile resolution;
- Codex, Claude Code, and a complete direct-only test profile proceed without a
  question;
- OpenClaw and Hermes ask direct versus webhook with direct as the default;
- agent kind and process configuration are rejected as tool input; and
- a failed direct launch never falls back to webhook.

These tests are mandatory on Linux, macOS, and Windows for every pull request
that changes delivery. Windows also runs native DACL checks and installs the
packed tarball before it can supply platform evidence under ADR 0040.

## Local real-agent suite

Real-agent qualification is opt-in and runs locally because it needs installed,
authenticated agent software and may incur model cost. It uses the local
central fixture by default, so provider integration can be tested without a
production identity or verification email.

The required matrix is:

| Agent | Webhook mode | Direct mode |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |
| Codex | not supported | required |
| Claude Code | not supported | required |

For each row:

1. Create an isolated provider profile and bounded working directory.
2. Start the packed Ambassador candidate with `start --verbose` and verify
   redaction; repeat the normal `start` path where needed.
3. Configure Ambassador MCP through the provider's supported mechanism.
4. Register a synthetic fixture identity and prove the real MCP client's exact
   name selects the expected fixed profile regardless of its reported version.
   Choose the requested mode when the dual-mode result asks, and prove direct
   is its advertised default.
5. Inject one permission message and one action message through the fixture.
6. Prove the real agent receives the complete message.
7. Prove the agent can call an allowed Ambassador MCP tool. For an action call,
   require one correlated `submit_action_result` call.
8. Prove the requester receives the resulting `action_response` before both
   delivered messages are acknowledged.
9. Exercise one bounded failure and confirm no unsafe replay.
10. While the gateway runs, exercise `sessions list` and both forms of
    `sessions show` against provider-created sessions. Then stop it and
    exercise `sessions delete` and `sessions forget`.
11. Scan the isolated state and output.

OpenClaw webhook qualification enables the built-in `/hooks/agent` endpoint in
the isolated configuration copy. Ambassador sends the native request directly;
no plugin or receiver mapping is installed. Direct qualification uses
OpenClaw's ACP command and its preconfigured Ambassador MCP entry.

Hermes webhook qualification uses its authenticated generic webhook path.
Direct qualification uses its fixed ACP command and provider MCP configuration.

Codex and Claude Code direct qualification use Ambassador's package-owned
public ACP adapters. Both load Ambassador MCP and other tools from normal
provider configuration; all ACP session requests carry an empty `mcpServers`
array. A Keychain-backed Claude subscription can be qualified against the
ordinary user home without modifying that configuration; the documented
Ambassador entry must already use port 8787. The runner records installed
provider and adapter versions as evidence but does not use them as allowlists.

On 2026-09-02, isolated installs of the three entry points approved at that
time passed ACP v1 initialization and returned the exact `agentInfo` identities
then listed in ADR 0038.
The reviewed OpenClaw and Hermes images also passed their version and ACP
startup probes. These are safe contract probes, not real-agent delivery passes.
The Codex direct case first passed against the local fixture. On 2026-09-03 it
passed the live correlated-result flow with packed candidate
`7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`
and reviewed central revision
`ac3f7a6e33829eb80301c7944f611d29cc2499b5`. Two disposable identities
registered and verified through Mailosaur. The controlled requester obtained a
synthetic phone permission, central polled the request and action to real Codex,
Codex called `respond_to_permission` and `submit_action_result` through the
injected Ambassador MCP server, and the requester received the correlated
`action_response` through its webhook before acknowledgement. The pass used a
narrow isolated policy representing the user's prior approval; it did not test
an interactive user prompt. Captured mail and temporary state were deleted.
The isolated credential copy was also removed. The installed Node was 24.14.0,
below the supported 24.19.0 floor, so repeat this case on a supported runtime.

On 2026-09-03, locally authenticated Hermes Agent 0.20.5 passed the same live
correlated-result flow in both delivery modes on macOS 26.5.2 arm64 and Node
24.19.0. The webhook case used the actual published Ambassador 0.2.7 tarball.
The direct case used a source candidate containing the new exact `0.20.5` ACP
entry. Hermes called `respond_to_permission` and called
`submit_action_result` exactly once; the requester received the correlated
response, and local acceptance or completion preceded central acknowledgement.
Both cases used isolated owner-only provider configuration and removed mail,
temporary Ambassador state, and copied provider credentials. See
[Live central qualification](live-qualification.md) for package digests,
separate mode outcomes, and the safe failure record.

Published Ambassador 0.2.7 still accepts only Hermes ACP 0.21.0 for direct
delivery. Its installed CLI rejected Hermes ACP 0.20.5 with `startup_failed`,
as expected. The candidate pass qualifies adding exact 0.20.5 to source; it is
not evidence that the already published 0.2.7 artifact has that support.

That evidence is retained to distinguish the published 0.2.7 artifact from its
later source candidate. The 0.2.10 matrix above supersedes its former list of
open cases: OpenClaw webhook and direct are complete, and the published 0.2.11
Claude Code observation above completes Claude direct. ADR 0043 removes Gemini
CLI from the current matrix and defers Antigravity. Hermes 0.21.0 retains only
its earlier contract and ACP startup probe and has not run the full real-model
round trip.

The runner must require explicit confirmation and use exact executables already
available on `PATH`. Those executables may come from an isolated installation
or a reviewed container wrapper prepared before the run. The runner never
installs, updates, or pulls an agent. It records:

- operating system and architecture;
- packed Ambassador digest;
- provider and ACP adapter versions;
- fixture revision;
- case names and pass/fail status; and
- confirmation that provider configuration supplied MCP tools and ACP received
  no additional server definition.

The installed-command version probe is observational. Run it without provider
credentials or model work:

```sh
pnpm run probe:agents
```

It checks OpenClaw, Hermes, Codex ACP, and Claude Agent ACP through fixed version
commands. A bounded semantic version is `observed`; a missing, failing,
malformed, or timed-out command is `unavailable`. Neither result skips a
delivery case. The production direct target separately requires ACP v1 and the
exact compiled-in ACP agent name after initialization; its reported version
remains observational.

On 2026-09-03, the current four-profile probe ran on macOS arm64 with Node
24.19.0:

| Profile | Probe status | Reported version |
| --- | --- | --- |
| OpenClaw | `observed` | `2026.8.2` |
| Hermes | `observed` | `0.20.5` |
| Codex ACP | `unavailable` | none |
| Claude Agent ACP | `unavailable` | none |

The default shell did not expose the two adapter executables to this probe.
Their separate authenticated qualification evidence remains recorded above;
`unavailable` is not a compatibility failure.

On 2026-09-03, the observational probe was rerun for the 0.2.9 candidate on
macOS 26.5.2 arm64 with Node 24.19.0. This table records the five-profile
artifact that existed at that time:

| Profile | Probe status | Reported version |
| --- | --- | --- |
| OpenClaw | `unavailable` | none |
| Hermes | `observed` | `0.20.5` |
| Codex ACP | `unavailable` | none |
| Claude Agent ACP | `unavailable` | none |
| Gemini CLI | `unavailable` | none |

`unavailable` means the executable was not available to this probe. It is not
a compatibility verdict. The candidate's deterministic registration and ACP
tests also passed with deliberately non-release version strings for every
known MCP client and with a mismatched ACP agent version under the correct ACP
v1 protocol and agent name.

The byte-final 0.2.9 candidate tarball had SHA-256
`49983cb0cf5b18ebaab9bbeab734dad837788c05f712c498a1e3cafc4ece015d`
and SRI digest
`sha512-faspZV5pqwtvwHJ8NxnW+KAoT2vLSu2oeYIc9RknjDl8m9oAYvqcTxVkcyj1yutqGpxWJKPHlg5xyXLpuwyYdw==`.
On Node 24.19.0 it passed clean installation, the installed-package REST E2E,
and the production vulnerability audit with no known vulnerabilities. The
signature audit verified 20 registry dependencies and reported only the
expected missing registry metadata for the unpublished local 0.2.9 candidate.
The full repository check passed 157 tests with no failures; the two opt-in
package lanes were skipped in that command, and the clean-installed package
lane then passed separately. Version 0.2.9 was not present in the npm registry
at verification time.

After all five pull-request gates passed, PR 15 merged as
`1d4a93c1c02f9abc7ca8c55761907c1a62be703f`. The main-branch Linux, macOS,
package, and Docker central-fixture jobs passed, and its OIDC job published
0.2.9 with the npm `latest` tag. The tarball downloaded directly from npm's
published `dist.tarball` URL matched registry SRI
`sha512-SgOUG35EtxTL02y9rWxvaDHnvmGgajY0a86w6ff2Jz+PEjpKXTHd2K+B0cuwb+yFjakl4PZDF039oQmsy4jOFw==`
and registry SHA-1 `293f1cc8b95b8306445aab02deb3286b0fc387ac`; its SHA-256 was
`e35e705f42411a29cf6afe185fc018de536230b717aebf25c15016a26118e5f6`.
A clean install of that registry tarball passed the installed CLI REST E2E, the
installed `ambassador` command rejected a forbidden option, the production
audit found no known vulnerabilities, and the signature audit verified all 21
packages with no invalid or missing entries. A separate check imported code
from that clean registry install: all five client names in that historical
artifact resolved with a deliberately non-release version value, and direct
ACP delivery completed
when the mock agent returned the correct ACP v1 protocol and agent name with a
different version.

On 2026-09-03, the published 0.2.9 registry tarball and the production source
were scanned for legacy development central-endpoint environment variables.
Neither contained them. A deterministic registration then set both old
variables to unreachable loopback URLs and still sent the request to
`https://mcp.embassys.ai/api/register_agent`. Ambassador has no central MCP
client or central MCP endpoint. Local fixtures continue to use the explicit
internal test seam described in the protocol.

The byte-final 0.2.8 release candidate tarball had SHA-256
`6e128f2ec84af29ad663226e1449de9c1fb894426b3982982cab0215667a24f4`
and SRI digest
`sha512-EWoq/E6GUHguCIhVi2qKWk0RUODPAsVHeAywbxEE8iDzKkXrj9r6EjarfheOujKP4V4Cxb3rCKzegc3HgjxxvQ==`.
On Node 24.19.0 it passed clean installation, the installed-package REST E2E,
and the production vulnerability audit with no known vulnerabilities. The
signature audit verified 20 registry dependencies and reported only the
expected missing registry metadata for the unpublished local 0.2.8 candidate.
The full repository check passed 158 tests with no failures; two separate
opt-in fixture lanes were skipped locally and remain required in CI.

After the green pull-request gates and main-branch OIDC workflow, npm published
0.2.8 and assigned `latest` to it. The downloaded registry artifact had npm SRI
`sha512-iGUTyiZW1X3ufniNgD8HvTniD56zVOHIgPuyLlaelAblU5nhYEV9aCgKpEUOCTvh+VaY72BfxAinssgQpHtUYQ==`,
registry SHA-1 `9188429b5933d7776cdf356578aad297bd3fc64b`, and tarball
SHA-256 `d6caf9a6c7285642bbd7ccdcb40fc89109dfd97deb157513071c8c50d6604e7c`.
Its extracted files were identical to the candidate despite the archive-level
digest difference. A clean registry-artifact install passed the REST E2E through
the installed CLI entry, the installed `ambassador` command rejected a forbidden
option, the production audit found no known vulnerabilities, and the registry
signature audit verified all 21 packages with no invalid or missing entries.

The runners do not record prompts, replies, message bodies, payloads, identities,
tokens, secrets, provider credentials, paths containing user data, or raw
provider output.

Build and pack the exact candidate, start the independent central fixture on
the default `http://127.0.0.1:8000`, and configure the two authenticated
webhook receivers. Then run:

```sh
export AMBASSADOR_CANDIDATE_TARBALL=/absolute/path/to/ambassador.tgz
export AMBASSADOR_QUALIFY_CONFIRM=run-installed-supported-agents
export AMBASSADOR_OPENCLAW_WEBHOOK_URL=https://receiver.example/openclaw
export AMBASSADOR_OPENCLAW_WEBHOOK_SECRET='<secret>'
export AMBASSADOR_HERMES_WEBHOOK_URL=https://receiver.example/hermes
export AMBASSADOR_HERMES_WEBHOOK_SECRET='<secret>'
pnpm run build
pnpm run qualify:agents
```

Put secret values in the process environment, never in command arguments. The
runner first requires the local fixture readiness endpoint, observes the
installed provider versions, loads the code from the exact candidate archive,
runs the delivery cases, and prints one safe JSON report. Configure each
provider's Ambassador MCP entry for `http://127.0.0.1:8787/mcp` without
authentication before starting the runner. Each direct case must call the
qualification `get_my_permissions` tool through normal provider configuration,
which proves the real MCP client's exact name match. Missing, unauthenticated,
or failing agents make the delivery case fail; a version-command observation
does not. The runner never invokes an installer or updater.

The reviewed OpenClaw 2026.8.1 and Hermes 0.21.0 images may provide their exact
executables. Pin `ghcr.io/openclaw/openclaw:2026.8.1` to manifest digest
`sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4`
and `nousresearch/hermes-agent:v2026.8.31` to manifest digest
`sha256:64923faeae267792bf9bf87fe3b4c4869e35004e360c7df01730ad801b74d524`.
Use isolated writable copies of provider configuration. Do not mount a user's
live configuration directory into a qualification container. Container
networking must preserve access to Ambassador's authenticated loopback MCP
listener; an image version or ACP handshake alone is not a real-agent pass.

The production ACP dependency is exact `@agentclientprotocol/sdk` 1.4.0. It is
Apache-2.0 licensed, as approved by ADR 0038, and remains subject to the normal
lockfile, audit, provenance, and packed-artifact checks.

## Live central suite

Live central qualification remains separate. It proves email registration,
DPoP, current REST schemas, permissions, correlated action results, message
consumption, and acknowledgement against
[mcp.embassys.ai](https://mcp.embassys.ai).

After the delivery cutover, its deterministic local target should exercise one
webhook delivery and one mock-ACP direct delivery. Running a paid real agent
against live central is optional and does not replace either the fixture-based
real-agent matrix or the deterministic live REST checks.

See [Live central qualification](live-qualification.md) for the existing
baseline evidence and safety rules.
