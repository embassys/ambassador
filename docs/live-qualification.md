# Live central qualification

## Purpose

This runbook records the controlled test of Ambassador's REST and DPoP client
against `https://mcp.embassys.ai`. It does not test central MCP, API-version
fallbacks, migration, token reissue, leases, conversations, or invented reply
operations.

The runner covers the current package name, guided registration, one
full-message webhook target, and one deterministic mock-ACP direct target. The
completed observation below predates ADR 0038 and proves only the central
client baseline.

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
8. Request and decide one synthetic permission.
9. Deliver one synthetic action message through each delivery mode.
10. Prove local acceptance or completion precedes central acknowledgement.
11. Record the consuming-poll restart-loss limitation.
12. Stop all processes, delete mail and temporary state, and scan artifacts.

Use the mock webhook receiver and mock ACP agent for this live REST test.
Real-agent OpenClaw and Hermes qualification remains a separate local matrix in
[Delivery qualification](qualification.md).

The controlled runner must require an explicit confirmation phrase before any
live request. It must record the reviewed central source revision or note that
the deployment does not expose one.

After packing and clean-installing the candidate, set
`AMBASSADOR_PACKED_CLI`, `AMBASSADOR_PACKED_TARBALL`, and
`AMBASSADOR_CONFIRM_LIVE_QUALIFICATION` to the confirmation phrase embedded in
`scripts/live-qualification.mjs`, then run `pnpm run qualify:live`. The runner
uses the mock ACP fixture compiled by `pnpm run test:build`; it does not run a
paid provider.

## Required report

Record only:

- date and reviewed server revision;
- live origin;
- packed Ambassador digest;
- qualification runner revision;
- status for each safe case;
- returned action names and schema digests;
- whether a DPoP nonce was observed;
- delivery mode used for each synthetic message;
- artifact-scan result; and
- the known consuming-poll limitation.

Do not include identities, IDs, codes, tokens, JWK coordinates, proof claims,
messages, action payloads, permission scopes, webhook details, prompts,
provider output, or remote error bodies.

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
