# 0062 Explicit local enrollment context

Status: accepted

Date: 2026-09-05

## Problem

Real Claude desktop tests interpreted a successful `get_my_permissions` response
with an empty list as an unregistered account. The model also selected its
desktop account email after the caller supplied an enrolled identity.

## Decision

Expose a bounded, allowlisted local enrollment summary in MCP initialization
instructions and successful `get_my_permissions` and `list_action_types`
responses. The summary states registration status, verified agent ID and email,
and whether the credential is active or expired. Read these fields from the
loaded enrollment, never from MCP client metadata or the provider account.
Do not expose the credential, token claims object, keys or proofs.

For a meeting involving the requester, guidance uses that verified email as
an attendee unless the user supplies another address. The target email selects
the remote agent; it does not automatically add the requester to an event.
The gateway still forwards exact caller payloads without inserting attendees.

An empty permission list does not change registration status. Initialization
metadata is a snapshot; later successful verification and tool results take
precedence. Unenrolled protected calls continue to fail with `not_enrolled`;
expired credentials remain enrolled and protected calls report
`credential_expired`. No new MCP tool, central endpoint or CLI option is added.

The user explicitly requested this fix before repeating the meeting test.
Regression coverage must distinguish unenrolled, enrolled with no permissions,
restart and expired-credential cases. Confirm the model behavior in a fresh
desktop conversation with ordinary user wording.
