# I05 packed gateway live E2E

Status: completed on 2026-09-02; retained as the controlled rerun procedure

## Purpose

Qualify the packed gateway against the current Embassys REST service and an
authenticated local qualification webhook. This runbook does not test central
MCP, `/api/v2`, migration, reissue, lease recovery, the removed
conversation/reply design, or a provider connector. Provider requalification
follows the separate connector redesign.

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
- I03 and I04 are complete in the candidate being qualified.
- `GET /api/list_action_types` returns the recorded `get_email` and
  `get_phone_number` schemas.
- The source pin and live origin in `server-integration-status.md` are current.
- A packed gateway has passed local artifact scans.
- The bounded local qualification webhook is available on an isolated
  loopback port.

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
14. Confirm the qualification webhook receives only ID-based wakes and that
    bodies are retrieved through local MCP.
15. Stop both gateways and run the complete artifact scan.

Do not claim restart recovery for a message already consumed from central.
Record that the current server cannot redeliver that body.

## Required report

Record only:

- date and source commit;
- live origin;
- gateway package digest;
- qualification harness revision;
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

## Completed observation

The 2026-09-02 packed run passed registration, email receipt, verification,
encrypted restart, the DPoP positive and negative matrix, six-action catalog
validation, permission request and decision, permission-response delivery,
`get_email` delivery, consuming polls, acknowledgements, and forbidden-marker
scans. It made no central MCP request and observed no initial nonce challenge.

The final protected `get_my_permissions` check returned the declared
email-field model and passed the strict gateway validator. This differs from
the pinned source construction and the earlier live server error. Captured
Mailosaur messages and all temporary gateway state were deleted.
