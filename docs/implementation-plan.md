# Current work

The user approved [ADR 0061](adr/0061-durable-workflows-and-client-delivery.md)
and requested implementation, regression coverage and live end-to-end testing.
The candidate is unpublished; API work remains issue-only.

Implemented:

- Independent encrypted notification custody, processing, provider delivery and
  acknowledgement workers, with one shared owner/ACP answer receiver.
- Six-tool MCP catalog with typed message_box, exact catalog/schema validation,
  owner questions and answers, explicit receipts and durable repeated checks.
- Streamable HTTP streaming and the installed SDK's current stateless protocol
  path, separate wait capacity, cancellation and restart recovery.
- Rotating development request/response logs with credential redaction and
  preservation through clean.
- Opt-in OpenClaw return extension and experimental Claude Code channel proxy.
  Hermes uses foreground waits until its public APIs support a trusted gateway
  destination and injection without unwanted interruption.
- Explicit public enrollment context in MCP initialization, catalog and current
  permissions responses. An empty grant list no longer implies missing
  registration. Resumed identities and expired credentials retain that context.
- Short delivery prompts with message-specific cues and complete payloads.
  Shared workflow guidance loads through MCP initialization. JSON is indented
  inside a code block; OpenClaw direct prompts omit the directory banner.
  A real-provider restart check confirms reuse of the incoming requester
  conversation, with separate conversations for different requesters.
- OpenClaw webhook delivery uses enrollment-scoped persistent requester keys.
  Real hooks reused the same provider history after recreating the delivery
  target, and separated a different requester. Temporary hook settings were
  restored. See ADR 0063 and the recorded qualification.

The real 600-second SDK/HTTP wait passed at 600.011 seconds using a controlled
central fixture, followed by a check that continued the same action without
resubmission. Deterministic regression cases cover owner continuation,
duplicate replies, partial operation bindings, ambiguous delivery, receipt,
cancellation and provider failure. See [workflow tests](workflow-test-plan.md).

Current checks pass: 340 deterministic tests, and the production build passes. The
preceding candidate passed the two clean-installed package
lanes, and six Docker fixture tests. Seven default-suite skips are four Windows
access-control cases and three separately invoked qualification cases. The
ten-minute test and both packaged lanes have been run explicitly.

Testing exposed and fixed JWK leakage into diagnostic bodies, a transient
atomic profile-write race, cancellation rejection handling during ACP startup,
interrupted prepared-action continuation, and stale pending inbox entries after
a reply had already completed. OpenClaw qualification also found separate
service/tool activation instances, native hook naming differences and stale MCP
connections after Ambassador restarted; all have regression coverage.

A subsequent real Claude desktop-to-OpenClaw test found and fixed the missing
foreground owner-answer continuation. Answers now enqueue durable local work,
recover interrupted handoffs, preserve the active question and use the original
central notification for any later provider approval. The repeated desktop run
displayed the exact result and acknowledged it after OpenClaw resumed from the
owner answer. It used a controlled central fixture. See the screenshot evidence
in [qualification](qualification.md).

The final runtime candidate passed the deployed REST action flow with real
Claude, Codex, Hermes and OpenClaw ACP targets. Each passed exact result and
receipt, running session reads, artifact scanning and cleanup. Claude also
passed two provider approvals. Codex and Claude passed provider history
deletion; Hermes and OpenClaw explicitly report it unsupported. All temporary
provider MCP entries and the OpenClaw extension settings were restored.

OpenClaw's real hooks returned each synthetic result once to the correct history
in two desktop conversations, including after an Ambassador restart. These
mixed desktop/RPC conversations sometimes retained a stale waiting view. A
fresh desktop-only retest was blocked when the Mac locked again. Native return
remains experimental; the extension preserves waits and leaves final results
unread until an explicit receipt.

Remaining implementation and qualification work:

- Meeting coordination exposed failures in the real Claude desktop/OpenClaw
  tests in [qualification](qualification.md). Explicit enrollment context now
  passes a fresh desktop observation. The user authorized Mac Calendar and a
  14:00–16:00 busy block for the follow-up. The first follow-up returned an
  approval decision instead of calendar data; guidance now distinguishes
  approval from execution and requires actual availability before scheduling.
  A later run verified the busy block, a real 16:00–16:30 local event and the
  late result in the original conversation. Invitation delivery failed because
  Mac Calendar required a personal Contacts card; the owner kept the event
  without an invite. The final attendee/refusal test selected the correct
  requester email and enforced denial before dispatch. Correct the model's
  advice about who may approve a denied request, qualify availability checking
  for explicit-time bookings, and retest invitation delivery with a configured
  test calendar. Check short desktop waits and unsought provider check-ins;
  neither is a qualified default ten-minute desktop wait.
- Resolve the Codex first-turn discovery failure observed during user-operated
  registration. Existing tool instructions already name Embassys and reject a
  website-URL question; check initial tool visibility and discovery metadata.
  Retest with short uncoached prompts. Record a consistent policy for neutral
  request reasons and supply an explicit permission reason when appropriate.
- Improve and repeat ordinary short-prompt qualification. Claude completed a
  real desktop-to-OpenClaw exchange after two ordinary answers, but asked an
  enrolled caller to reconfirm registration and selected a 60-second follow-up
  wait. The new enrollment guidance removed that question in a fresh meeting
  test, whose initial request used the default wait. Repeat the short phone
  request without adding technical instructions to the user prompt.
  The observed run and its limits are in [qualification](qualification.md).
- Repeat OpenClaw native display checks in fresh desktop-only conversations,
  then qualify the remaining native failure cases in the workflow test plan.
- Claude desktop Code mode passed the exact result and receipt flow against a
  controlled fixture. The user-operated Codex desktop registration and result
  flow also completed after a discovery hint; its client selected 50-second
  waits. Qualify full ten-minute desktop waits, the experimental Claude Code channel and Claude
  Chat/Cowork separately. Hermes native return remains deferred for the
  public API limitations in [client delivery](client-delivery.md).
- Qualify the current real webhook modes, the minimum supported Node version
  and Windows. Earlier published-version passes do not qualify this candidate.
- Pass the remaining release gates before publication. The user approved
  detailed request/response retention for this development release; ADR 0059
  records that decision.

API follow-ups are [1](https://github.com/embassys/agent2agent/issues/1),
[2](https://github.com/embassys/agent2agent/issues/2),
[3](https://github.com/embassys/agent2agent/issues/3),
[4](https://github.com/embassys/agent2agent/issues/4) for uncertain submissions,
[5](https://github.com/embassys/agent2agent/issues/5) for correlated remote
waiting-for-owner progress, and
[6](https://github.com/embassys/agent2agent/issues/6) for action result schemas.
No API code changed.

## Earlier implementation and release evidence

The records below describe earlier candidates and the published 0.2.18 baseline.
They do not qualify ADR 0061's new workflow or original-conversation return.

ADR 0058's confirmed process stop is implemented. `start` and `clean` ask in an
interactive terminal before stopping the authenticated instance, then acquire
its released lock before proceeding. The full local check passed 274 tests
with six expected skips. Separate terminal processes also passed confirmed
start replacement and cleanup. Refusal, cancellation, a changed instance, and
shutdown timeout have deterministic coverage. These changes are unpublished.

ADR 0057's Ambassador changes are implemented: shared delivery intent
instructions, MCP session reclamation, exact provider approval choices, local
access after credential expiry, bounded ACP close, recoverable confirmed
outbound rejection, and bounded verbose response reads. Regression tests, the
full local check, a clean-installed package test, and controlled live REST
qualification passed. The live run used a mock ACP agent and a controlled
webhook receiver; the real-provider matrix has not been repeated for these
changes. See [Delivery qualification](qualification.md) for candidate evidence.

The user requested API issues instead of server code changes. Message custody
and batch bounds are in [API issue 1](https://github.com/embassys/agent2agent/issues/1),
credential renewal in [API issue 2](https://github.com/embassys/agent2agent/issues/2),
and listener lifecycle in [API issue 3](https://github.com/embassys/agent2agent/issues/3).
These remain production limitations. No API code was changed, and the
Ambassador changes have not been published.

ADR 0056 is implemented and qualified. Indexed encrypted stores allow 1 GiB
each, `get_inbox` pages safely, receipt capture covers approval polling, and
saved outbound intent dispatches the exact requested payload after a grant.
ACP sessions reuse context per remote identity while tracking each message and
action independently. Idle cleanup runs in bounded background batches. Existing
state and migration are outside the approved scope.

The deterministic suite, clean-installed live REST flow, real two-turn context
recall with all four providers, and combined real Codex-to-Claude action round
trip passed. The combined run also verified peer-session reuse and running
session reads on both gateways. OpenClaw uses its reviewed load path to restore
its gateway mapping. See [Delivery qualification](qualification.md)
for versions, artifact digests, and the limits of these checks.

PR 37 merged and version 0.2.18 was published on 2026-09-05. All six provider
delivery modes and every main-branch release gate passed, including Windows.
The independently downloaded npm artifact matched the qualified candidate and
passed clean-install, runtime, artifact, vulnerability, and signature checks.
The user deferred further Windows fixes to a separate pull request; no further
Windows change or release-gate exception was needed after the merge.
ADR 0057 replaces the deferred approval mapping with exact provider choices;
central recovery remains server work.

Phase 3B is complete. ADR 0050's common ACP policy, public Codex and Claude
adapters, persistent session lifecycle, session commands, verbose diagnostics,
provider-configured MCP use, retention cleanup, documentation, and deterministic
coverage are implemented. A clean packed Codex-to-Claude live run also passed
the deployed email-decision permission flow, all public CLI commands, and the
correlated action-result round trip. Evidence is in
[Delivery qualification](qualification.md).

ADR 0051's encrypted received-action-result storage is implemented. ADR 0052
replaces the three separate inbox views with `get_inbox`, which combines
unanswered action calls, unread action results, and ADR 0056's outbound status.
ADR 0054 replaces agent-side
Embassys permission decisions with the deployed human email flow and updates
the current request schema and live qualification. Verbose ACP logging reports
the available-command count without printing the command catalog or its
descriptions.

ADR 0055's implementation replaces automatic ACP tool approval with
`get_human_input`. The deterministic gateway test proves that the ACP request
remains pending, the local agent's own owner receives the question, the answer
is received as a correlated `human_input_response`, unrelated messages are
preserved, the control response is not prompted to the provider, and all
messages are acknowledged in order.

ADR 0053's live session inspection is implemented. `sessions list` and
`sessions show` use the foreground process while it runs; destructive session
commands remain stopped-only.

The controlled live Codex-to-Claude qualification of ADR 0055 passed against
the deployed own-human input endpoint. Version 0.2.18 is published under the
npm `latest` tag.

The deterministic Windows lanes cover state, startup, packaging, and mock
delivery. A support claim for an individual real-agent mode on Windows still
requires that exact agent's native qualification under ADR 0040.

Optional central service work remains in
[Central follow-ups](central-follow-ups.md). It does not authorize client-side
fallbacks or compatibility code.
