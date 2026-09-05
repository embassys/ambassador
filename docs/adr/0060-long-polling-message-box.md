# 0060 A long-polling message box

Status: accepted

Amended by [ADR 0061](0061-durable-workflows-and-client-delivery.md) for
independent durable receipt, owner input, client wait budgets and native routes.

Date: 2026-09-05

## Decision

Expose one `message_box` MCP tool for action requests, permission-only requests,
action results, inbox reads, checks, and receipts. Replace the separate business
tools. Keep registration, verification, resend, catalog discovery, and current
permission listing as immediate tools. Each message type has a strict schema.
Central REST calls and the human email decision flow stay unchanged.

Initial action and permission messages carry a caller-generated request UUID.
Persist the exact input fingerprint and operation before any external mutation.
A repeated ID with identical input observes that operation. Changed input is
rejected. A crash or ambiguous response leaves an uncertain operation that must
never automatically submit again. The exact action name is selected from the
current catalog and used for both permission and saved payload dispatch.

The initial call submits once and then stays open for a total of up to 600
seconds. Return earlier for a related decision, result, input requirement,
definitive rejection, or uncertainty. An ordinary acceptance receipt does not
end a pending action wait. Checks wait on the same operation for another 600
seconds. A timeout returns pending state and an exact check continuation with
guidance to ask again. It never schedules a future call or resubmits an action.

Keep at most 32 local waits, separate from the eight ordinary tool slots.
The HTTP request parsing deadline stays 35 seconds. Valid message-box waits
receive a 605-second transport/handler budget, with the business response due
at 600 seconds. Shutdown and disconnect release waits. Central requests keep
their existing shorter deadlines. Qualify provider client timeouts explicitly.

The current polling owner captures messages before delivery and fans related
events into the message box. There is no extra central poll per waiter. Messages
owned by a message-box operation are retained for that operation, so a separate
ACP turn cannot execute the same outbound action. Unsolicited action calls keep
the configured delivery path and pending inbox.

Add one encrypted operation store with the existing 1 GiB quota and 512 KiB
record bound. It holds bounded IDs, fingerprints, status, correlation, and up to
32 small event records per operation. Action result bodies stay in the existing
encrypted result inbox and are referenced by call ID. This adds a bounded
durable exception for related permission status and local operation events.
The ID-only notification journal remains unchanged.

Returning a result does not remove it. A subsequent check carrying its opaque
event cursor, or an explicit receipt, acknowledges it. Inbox reads also return
explicit result receipt instructions. A timeout does not advance a cursor.
Persist acknowledgement before removing referenced result bodies. Keep a small
operation tombstone and fingerprint so an old request ID cannot execute again.
Storage exhaustion is explicit; never evict unresolved work or silently forget
deduplication. Existing-state migration remains outside this development scope.

This amends ADRs 0037, 0052, and 0056 for the public business tool and receipt
semantics. Diagnostic logs are never read for recovery. Central's consuming-poll
loss and lack of idempotency remain server limitations, tracked as API issues.

## Approval

The user approved the written plan, clarified that the initial request itself
must remain open for ten minutes with repeated user-driven checks, and asked
to implement all changes with basic checks followed by live end-to-end testing.
No central API code, new dependency, CLI option, or publication is authorized.
