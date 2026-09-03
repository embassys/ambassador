# Live central qualification

## Purpose

This runbook records the controlled test of Ambassador's REST and DPoP client
against `https://mcp.embassys.ai`. It does not test central MCP, API-version
fallbacks, migration, token reissue, leases, conversations, or invented
general reply operations. It does test the deployed, action-specific
`submit_action_result` contract.

The runner covers the current package name, guided registration, one
full-message webhook target, and one direct target. The default direct target
is the deterministic mock ACP agent. A separately confirmed mode uses the
fixed Codex profile and `codex-acp` 1.8.0 with an isolated Codex login.

## Safety

- Use disposable Mailosaur addresses and synthetic action data.
- Read Mailosaur credentials from approved local secret storage.
- Keep addresses, codes, tokens, keys, proofs, messages, and payloads out of
  commands, files, logs, screenshots, and reports.
- Capture only route names, status, timing, digests, and safe pass/fail evidence.
- Delete captured mail and all temporary state in cleanup.

## Required live checks after the cutover

1. Pack and scan the exact candidate package.
2. Create two disposable identities through authenticated local MCP.
3. Use the exact enabled `clientInfo` aliases for one webhook profile and one
   direct profile. Prove the dual-mode registration result advertises direct
   as its default before choosing the required mode.
4. Receive and use both verification emails without persisting their codes.
5. Restart and prove encrypted credential and nonsecret profile loading.
6. Prove valid Bearer plus DPoP requests and the negative DPoP matrix.
7. Validate the live action catalog against the recorded fixture schemas.
8. Request and decide one synthetic `get_phone_number` permission.
9. Deliver the action request to the direct target.
10. Submit one correlated synthetic result from the target and deliver the
    resulting `action_response` to the webhook requester.
11. Prove each local acceptance or completion precedes its central
    acknowledgement.
12. Record the consuming-poll restart-loss and non-idempotent result-submission
    limitations.
13. Stop all processes, delete mail and temporary state, and scan artifacts.

Use the mock webhook receiver and either the mock ACP agent or the fixed real
Codex mode for this live REST test. Real-agent qualification for all five
enabled profiles remains a separate local matrix in
[Delivery qualification](qualification.md).

The controlled runner must require an explicit confirmation phrase before any
live request. It must record the reviewed central source revision or note that
the deployment does not expose one.

After packing and clean-installing the candidate, set
`AMBASSADOR_PACKED_CLI`, `AMBASSADOR_PACKED_TARBALL`, and
`AMBASSADOR_CONFIRM_LIVE_QUALIFICATION` to the confirmation phrase embedded in
`scripts/live-qualification.mjs`, then run `pnpm run qualify:live`. In default
mode, the runner uses the mock ACP fixture compiled by `pnpm run test:build`
and does not run a paid provider.

For the real Codex mode, prepare an owner-only temporary home containing only
the copied Codex authentication needed for the run. Put exact
`codex-acp` 1.8.0 on `PATH`, then set:

```sh
export AMBASSADOR_LIVE_DIRECT_AGENT=codex
export AMBASSADOR_CODEX_QUALIFICATION_HOME=/absolute/path/to/isolated/home
export AMBASSADOR_CONFIRM_LIVE_QUALIFICATION=run-live-qualification-with-real-codex-and-two-disposable-mailosaur-identities
pnpm run qualify:live
```

The runner rejects an ordinary user home, checks the adapter version before it
contacts central, uses the compiled-in Codex command and profile, and never
accepts a command override. It also lets abandoned server-side polls expire
after the restart check before it enqueues a message. Delete the isolated home
after the run.

## Required report

Record only:

- date and reviewed server revision;
- live origin;
- packed Ambassador digest;
- qualification runner revision;
- status for each safe case;
- whether the target submitted a correlated action result and the requester
  received it;
- returned action names and schema digests;
- whether a DPoP nonce was observed;
- delivery mode used for each synthetic message;
- artifact-scan result; and
- the known consuming-poll and result-submission limitations.

Do not include identities, IDs, codes, tokens, JWK coordinates, proof claims,
messages, action payloads, permission scopes, webhook details, prompts,
provider output, or remote error bodies.

## Correlated-result observation

At 00:43 BST on 2026-09-03, the real Codex mode passed against the live service
with `codex-acp` 1.8.0 and packed candidate
`7cbbf27fbd401024c51a48f6ae6b0a0b55059df200035cdbb33c72faf9ab4d70`.
The runner's UTC date field was still 2026-09-02. The reviewed central source
revision was `ac3f7a6e33829eb80301c7944f611d29cc2499b5`, the exact runner digest was
`769959d2bec4f7b436b9376570e940a14756c4f563e5f07343de9475c4cf3236`,
and the deployment did not expose its revision.

The run registered and verified two disposable Mailosaur identities. The mock
requester used webhook delivery; the target used direct ACP delivery to real
Codex. The requester asked for `get_phone_number`. Codex received the
`permission_request` through Ambassador's central poll and called
`respond_to_permission`. After central returned the grant to the requester's
webhook, the requester called `call_action`. Codex received the correlated
`action_call` and called `submit_action_result` exactly once with its `call_id`,
`success`, and the approved synthetic phone object. Central returned
`completed` and queued an `action_response` with the same call ID, action type,
status, and result. The requester received that response through its webhook,
and Ambassador acknowledged it.

The same run also passed encrypted restart, the DPoP positive case and missing,
wrong-key, stale, future, wrong-URL, wrong-method, wrong-token-hash, and replay
failures, the six-action live catalog and schema digests, acknowledgement order,
zero central MCP requests, artifact scanning, and mail and temporary-state
cleanup. The external isolated credential copy was removed after the run. No
defect appeared in the live `submit_action_result` path.

The pass used an owner-only `AGENTS.md` in the isolated Codex working directory
to represent the user's prior approval of only this synthetic permission and
result. It did not test a live interactive prompt to the user. An earlier run
without that local policy reached Codex, which called `respond_to_permission`,
but the permission was not granted; no action or result submission followed.
This is expected for a background ACP session with no interactive user.

A second attempt accepted the permission request but timed out before Codex
received it. The source and request sequence indicate that an abandoned
server-side long poll from the deliberate restart consumed the queued message
after its local HTTP request had been aborted. Central marks messages delivered
during polling and provides no lease or redelivery. The runner now waits 31
seconds after stopping the old gateways before it starts replacements; the
subsequent run passed. This is evidence of the existing restart-loss window,
not a failure of the result endpoint.

The live process used installed Node 24.14.0, below the package's declared
24.19.0 floor, because no in-range Node runtime was installed. Functional live
behavior passed. The supported-Node repeat remains part of the qualification
record even though the user approved 0.2.6 as a one-release exception before
that repeat.

## Earlier direct observation

On 2026-09-02, real Codex had already passed delivery, injected Ambassador MCP
use, and acknowledgement with candidate
`22a65d370897172a726b4890bade780e907c2c38ccf5d6cb5e347c9c01f14ec7`.
That run predated adoption of `submit_action_result` and is not evidence for the
correlated-result contract. Earlier mock-target delivery timeouts remained
unexplained at that point; the restart race above now explains one reproducible
class of such timeout.

## Baseline observation

On 2026-09-02, the packed pre-ADR-0038 implementation passed registration, Mailosaur
email receipt, verification, encrypted restart, the DPoP positive and negative
matrix, six-action catalog validation, permission request and decision,
permission-response delivery, one `get_email` delivery, consuming polls,
acknowledgements, and forbidden-marker scans.

It used no central MCP request and observed no initial nonce challenge. The
final `get_my_permissions` check matched the deployed email-field model.
Captured mail and temporary process state were deleted.

This observation remains useful evidence for ADR 0037 only. It is not release
evidence for the Ambassador delivery cutover.
