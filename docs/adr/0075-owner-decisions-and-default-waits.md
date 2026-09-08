# 0075. Owner decisions and ten-minute default waits

Status: accepted, 2026-09-08. The owner requested ten-minute waits even when a
client disconnects earlier, and approved the remaining local work after the web
API comparison. Central implementation and distribution remain excluded.

Supersede ADR 0074's 45-second recommendation. Keep 600 seconds as the default,
preserve explicit shorter waits, and explain continuation in initialization and
tool help before a client can disconnect. A dropped connection cannot receive a
late tool reply. Accepted work and unread results remain durable; ask the user
to check the same request later without scheduling or resubmitting it.

Amend ADR 0068's read-only boundary to use the deployed owner decision, answer
and revocation routes reviewed at web_app a9cb3d3 and agent2agent a8c0e77. These
already authorize the owner and share pending-state transactions with email.
This does not claim full audit history or server mutation recovery.

Review a fresh request before offering controls. Present the exact known server
permission menu, or exact supplied provider button labels and values. Unknown
menus, malformed choices and expired requests cannot be submitted. Show missing
reason or source context explicitly. Confirm the reviewed choice in the app;
re-fetch and compare the complete reviewed record immediately before submission.
Reviews expire after five minutes and are scoped to the current owner context.

Persist a no-replay marker before every mutation. Reuse the encrypted record
store with a separately scoped owner storage secret, never an agent credential.
The indexed journal is capped at 1 GiB and holds account/request IDs, action name,
timestamps, an encrypted submission fingerprint and confirmation state, not
credentials or answer bodies. A different answer cannot reuse an earlier
submission's confirmation. Sign-out,
restart and gateway Clean preserve it. Unconfirmed markers never expire or replay.
Confirmed and no-longer-pending markers prevent repeated mutation of that ID.
Definitive rejection can be reviewed again. Unknown HTTP, malformed success,
lost IPC or a failed local commit cannot become a successful decision by inference.
Unconfirmed decisions remain visible even after the pending request disappears.

No renderer-supplied endpoint, bearer, account ID or provider approval mapping is
accepted. Owner mutations remain private app commands and do not enter MCP.
Tests cover email/app races, stale reviews, unknown menus, exact options,
duplicate clicks, account changes, restart, persistence failure and lost responses.
Run controlled live app decisions through the deployed API before qualification.
