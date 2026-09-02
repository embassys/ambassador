# Live central qualification

## Purpose

This runbook records the controlled test of Ambassador's REST and DPoP client
against `https://mcp.embassys.ai`. It does not test central MCP, API-version
fallbacks, migration, token reissue, leases, conversations, or invented reply
operations.

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
8. Request and decide one synthetic permission.
9. Deliver one synthetic action message through each delivery mode.
10. Prove local acceptance or completion precedes central acknowledgement.
11. Record the consuming-poll restart-loss limitation.
12. Stop all processes, delete mail and temporary state, and scan artifacts.

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
accepts a command override. Delete the isolated home after the run.

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

## Cutover observation

On 2026-09-02, the real Codex mode passed against the live service with packed
candidate
`22a65d370897172a726b4890bade780e907c2c38ccf5d6cb5e347c9c01f14ec7`
and `codex-acp` 1.8.0. The reviewed central source revision was
`c226d7c4318996c67e8caaad36b978a2e61aa2cc`; the deployment does not expose
its revision.

The run passed:

- registration and Mailosaur delivery for two disposable identities;
- email verification and encrypted restart;
- the DPoP positive case and missing, wrong-key, stale, future, wrong-URL,
  wrong-method, wrong-token-hash, and replay failures;
- the six-action live catalog and recorded schema digests;
- permission request, decision, consuming poll, and webhook response delivery;
- action delivery through a consuming poll to real Codex;
- a `get_my_permissions` call from Codex through the injected Ambassador MCP
  server;
- central acknowledgement after both webhook acceptance and Codex completion;
- zero central MCP requests; and
- artifact, mail, temporary Ambassador state, and isolated Codex credential
  cleanup.

No live server defect appeared in the passing run. Earlier attempts remain
useful failure evidence. Two mock-target attempts registered and verified both
identities but timed out at different delivery stages. The first real-Codex
attempt reached Codex, and Codex granted the permission itself. The runner then
sent a duplicate decision, which central correctly rejected with HTTP 400.
After the runner accepted an already-granted decision, a fresh run passed. The
earlier delivery timeouts did not reproduce, so they remain unexplained rather
than confirmed server defects.

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
