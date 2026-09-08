# Native owner decisions, September 8

ADR 0075 restores the owner's requested ten-minute default for standalone Claude
and implements the existing owner approval, answer and revocation endpoints.
Central API code, provider profiles and distribution were not changed.

## Native and deployed API checks

The unsigned packaged Mac app ran with a fresh isolated owner profile. Two
centrally enrolled disposable Mailosaur identities supplied test requests.
Owner sign-in was prepared through the real owner service before launch; this
run qualifies the new decision UI, not a repeated native onboarding test.

Owner: `live-owner-owner-0e76d6c0@zzncpfab.mailosaur.net`.
Requester: `live-owner-requester-f0cce183@zzncpfab.mailosaur.net`.

The actual native UI and deployed API passed:

1. Review `once_always`, choose **Allow once**, then confirm. Permission
   `ba781862-2ec6-490c-8585-b5c26a2dea17` became granted, and the requesting test
   identity received the correlated `permission_outcome`.
2. Answer button question `6a2aa98f-94dd-4c33-abcc-767c957107d0`. The asking test
   identity received `human_input_response` with exact value `provider:test-once`.
3. Answer text question `a4fccbfd-3146-45d6-a0c3-1f99e4dcba8d` with the synthetic
   phrase `blue teapot`. Its correlated central response contained that text.
4. Review and revoke the unused one-use grant. The requester saw revoked status
   and received `permission_revoked`.
5. Review an `accept_deny` request, choose **Deny**, then confirm. Permission
   `442ff076-c096-4917-9a28-a22c16e95878` became denied, and the requester received
   the denied outcome. No action was executed.
6. Sign out through the native Account screen, return to Welcome and quit. The
   temporary state directory was removed. Existing provider profiles were untouched.

Screenshots and metadata are in `.build/owner-decisions-live/`, including
`01-permission-review.png`, `02-button-answer.png`, `03-text-answer.png`,
`04-revocation.png`, `05-deny.png`, `06-confirmed.png` and `evidence.json`.
These checks use real central requests and the native app, but no model execution.
Earlier real Claude/OpenClaw conversation qualification remains separate evidence.

The first driver exited because its input pipe was closed. A second attempt
confirmed a native approval but the follow-up checker passed an object where
`pollRemoteMessages` requires a number. It failed locally before polling and is
recorded in `driver-failure.json`. Neither attempt is counted as a completed flow.
The final corrected run above passed every check.

## Regression coverage and limits

Core checks pass 503 tests with seven expected skips. Desktop rendering, parser
and artifact checks pass 19 tests. Owner regressions cover exact buttons and text,
unknown menus, duplicate options, stale scope, review expiry, account changes,
email/app conflicts, definitive rejection, uncertain HTTP responses, mismatched
success bodies, disk failure before and after submission, restart and sign-out.
A different answer cannot reuse an earlier submission's confirmation. The
indexed encrypted marker store keeps uncertainty visible after pending-list
removal and never resubmits it. Owner storage secrets remain separate from
agent keys, and wrong secrets/scopes fail authentication.

The Mac CI failure was reproduced by starting the stdio relay through a directory
alias. Comparing the unresolved entry path with the canonical module path caused
an immediate exit. Canonicalizing the entry path fixes the regression; the same
test uses a directory junction on Windows. The bundled worker and stdio client
also pass the packaged test with an isolated PATH. This does not claim a signed
release or replace native Windows/Linux qualification.

The first CI run passed Mac and Linux but exposed a Windows timing failure in
the existing ACP approval-pause regression. That test now advances a controlled
clock beyond both deadlines only after the real mock-agent approval arrives.
It still fails when either deadline's pause is removed, without counting process
startup and durable writes against a one-second wall-clock budget. Production
timeouts are unchanged.
The next Windows run passed that test but exposed the same timing assumption in
the close-timeout test. It now waits for the mock agent to report that close is
pending before advancing the clock. It still requires a bounded close failure,
a preserved completed prompt and no replay.
The shared fixture gives healthy process/disk stages five seconds and cleanup
two seconds. Deadline-specific cases still select their own budgets. Removing
the outer deadline makes the close regression fail its test timeout.

Ten-minute waits and exact shorter user requests are preserved by the relay.
Initialization and tool metadata explain that an early host disconnect leaves
accepted work available through a later check. A closed connection cannot receive
late guidance. The earlier Chat/Cowork host deadlines remain observed limitations;
this change does not claim to extend their timeouts or add automatic retries.

The final UI also closes an expired or rejected review and prompts a fresh review.
Server source-call context, the original permission reason, complete history,
identity recovery and recoverable owner mutations remain API follow-ups. This
implementation does not infer a successful decision from pending-list removal.
