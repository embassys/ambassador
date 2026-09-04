# 0054 Email-only Embassys permission decisions

Status: accepted

Date: 2026-09-04

## Problem

The deployed Embassys permission flow now asks the grantor's human to decide by
email. It deliberately queues no `permission_request` to the grantor's agent.
Ambassador still exposed `respond_to_permission` and projected pending central
rows into `get_inbox`, which presented a second decision path that no longer
matches the product.

This Embassys resource permission is distinct from an ACP provider asking
Ambassador whether a background agent may execute one of its tools.

## Decision

- Remove `respond_to_permission` from Ambassador's MCP catalog and REST client.
- Make `get_inbox` contain only unanswered action calls and unread action
  results. Keep `get_my_permissions` as the status and audit view.
- Match the deployed `request_permission` schema: require at least one of
  `target_email` / `message_id` and exactly one of `action_type` /
  `permission_type`; when both target selectors are present, `message_id`
  takes precedence and central requires the email to agree. Accept optional
  `decision_options`, `reason`, and `scope`.
- Accept the deployed response decisions `accept`, `deny`, `allow_once`, and
  `allow_always`. Branch on `already_granted` rather than assuming a human must
  still decide.
- Treat the emailed token as a human credential. Ambassador does not receive,
  persist, log, or submit it in production. The controlled live runner may use
  a disposable mailbox and the JSON decision endpoint to exercise the human
  step without exposing the token.
- In qualification, request the `once_always` menu, prove the grantor's agent
  receives no inbox item, apply `allow_once` from the disposable email, and
  verify the requester's `permission_outcome` before making one action call.

ACP tool-execution permission is separate from the Embassys resource
permission described here. ADR 0055 later routed ACP permission through the
same central email and polling mechanism without exposing it as an MCP tool.

## Consequences

The human receives one clear approval channel. The grantor's unattended agent
cannot approve access on the owner's behalf, while the requester still learns
the asynchronous result through normal central delivery.

Ambassador's local inbox becomes smaller and stops making an unnecessary
central permission-list request. Existing installations do not retain an alias
for the removed tool.

## Approval

The user supplied the deployed email-permission contract and confirmed the
human email flow on 2026-09-04.
