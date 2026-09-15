# 0085. Account communication history

Status: accepted, September 15, 2026. The owner approved the remaining history,
provider qualification, test-helper and documentation work, plus a live Mac
walkthrough. This extends ADR 0082 using the shipped issue 18 contract.

Read `GET /api/owner/communications` through the private owner worker. Review
source revision `8c648d8920ad39f970c476cc63d4840c0a38be4d` and deployed OpenAPI
together. Use pages of 50 to stay within the existing response-size budget.
Validate message identities, direction, timestamps, pagination and retention.
Do not poll, acknowledge, replay or import these records into execution custody.

Group account messages by the two central agent IDs. Use an exact, unique local
peer-session match to combine them with local history. Ambiguous matches stay
separate. Deduplicate central messages by message ID and local incoming records
by their saved message ID. Do not infer action success from delivery state.
Deleted senders remain explicitly unnamed. Names from payload text never supply
an identity. Both ends belonging to the owner remain distinguishable.

The sidebar includes conversations from the account as well as this device.
Read recent pages in memory, with explicit earlier-page loading, bounded counts
and bytes, duplicate cursor detection and stale-account rejection. Refresh keeps
loaded older pages when they overlap. An offline read preserves the last view
with a visible error. Sign-out clears account data; no new durable history copy
or retention policy is introduced. Show server retention limits in conversation
details. Deleting local history does not delete account messages.

Tests precede implementation. Cover overlap, equal timestamps, missing senders,
internal traffic, foreign identities, invalid cursors, account changes, offline
reads, local deduplication and retention. Live qualification must read a queued
message repeatedly and then prove normal agent reception and completion still
work. Native screenshots must come from the real app, with controlled test
identities and ordinary provider prompts. Preserve existing provider settings.

No server changes, dependency additions, public CLI changes or release are
included. Provider routing and busy-session requirements in ADR 0061 remain.
