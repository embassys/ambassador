# Live E2E with OpenClaw or Hermes

Status: I05 runbook; do not run until I02 through I04 pass

## Purpose

Qualify the packed gateway against the current Embassys REST service and one
local runtime. This runbook does not test central MCP, `/api/v2`, migration,
reissue, lease recovery, or the removed conversation/reply design.

## Safety

- Use disposable Mailosaur addresses and synthetic action data.
- Read Mailosaur credentials from the approved macOS Keychain entries.
- Keep addresses, codes, tokens, keys, proofs, messages, and payloads out of
  commands, files, logs, screenshots, and reports.
- Capture only status, timing, route name, and safe pass/fail evidence.
- Delete captured mail and all temporary state in cleanup.
- Do not use a real personal email or phone value in an action payload.

## Preconditions

- I02 replacement fixtures and tests are green.
- I03 and I04 are merged.
- `GET /api/list_action_types` returns the recorded `get_email` and
  `get_phone_number` schemas.
- The source pin and live origin in `server-integration-status.md` are current.
- A packed gateway has passed local artifact scans.
- A supported OpenClaw or Hermes version is installed and configured with no
  production credential in the repository.

## Run

1. Create two unique Mailosaur addresses for this run.
2. Start one clean gateway instance for the first identity and one for the
   second identity in isolated local state and on isolated loopback ports as
   supported by the test harness.
3. Register each identity through its authenticated local MCP endpoint.
4. Retrieve each verification email, extract the code in memory, verify with a
   gateway-generated P-256 key, and delete the mail.
5. Restart both gateways and prove they load their encrypted credentials.
6. Run protected negative checks with an isolated test client: missing proof,
   wrong key, replay, stale and future proof, wrong method, wrong URL, and wrong
   token hash.
7. Confirm a valid poll uses `Authorization: Bearer` plus `DPoP` and succeeds
   without a proactive nonce.
8. List action types and compare the response with the pinned schemas.
9. Request one low-impact synthetic permission from identity A to identity B.
10. Poll B, retrieve the permission message through local MCP, decide it with
    `respond_to_permission`, and acknowledge it.
11. Poll A and acknowledge the permission response.
12. Call the approved action from A to B using only synthetic data.
13. Poll B, retrieve the action message, and acknowledge it.
14. Confirm the configured OpenClaw or Hermes webhook receives only ID-based
    wakes and retrieves bodies through local MCP.
15. Stop both gateways and run the complete artifact scan.

Do not claim restart recovery for a message already consumed from central.
Record that the current server cannot redeliver that body.

## Required report

Record only:

- date and source commit;
- live origin;
- gateway package digest;
- local runtime name and version;
- status for each step;
- returned action names and schema digests;
- whether a DPoP nonce was observed;
- artifact-scan result; and
- the known consuming-poll limitation.

Do not include addresses, IDs, codes, tokens, JWK coordinates, proof claims,
messages, action payloads, permission scopes, or remote error bodies.

## Cleanup

- Stop gateway and runtime processes.
- Delete temporary gateway and connector state created for the run.
- Delete all captured Mailosaur messages.
- Confirm no temporary report contains a forbidden marker.
- Leave no central credential in a shared development profile.
