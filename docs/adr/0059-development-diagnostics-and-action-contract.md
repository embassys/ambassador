# 0059 Development diagnostics and exact action contracts

Status: accepted

Amended by [ADR 0061](0061-durable-workflows-and-client-delivery.md) for
standards-based schema validation and expanded workflow diagnostics.

Date: 2026-09-05

## Decision

Record structured diagnostics whenever the foreground CLI runs. Include bounded
MCP, central, delivery, lifecycle, approval, and error events with UTC times,
request/run IDs, durations, and request and response data. Verbose mode adds the
same redacted detail to the console. Development body retention is explicitly
approved; credentials, verification codes, keys, proofs, nonces, cookies, and
secrets must still be removed before any write.

Use JSON Lines in the owner-only `diagnostics` directory inside Ambassador's
state directory. Print its location at startup. Retain four files of at most
8 MiB each, with 64 KiB record bounds and a bounded write queue. Report dropped
records or disk failures. Logging must not replay an operation or block an
accepted result. `clean` preserves diagnostics so a reset can be investigated.
This is the first implementation of the user's request for a log location or
export command; it adds no command, option, dependency, or installer.

This temporarily amends the console-only logging and body-persistence rules in
ADRs 0037, 0050, and 0051 for development diagnostics. Logs are not inboxes or
recovery input. On 2026-09-05, the user explicitly approved retaining this same
detailed logging in the upcoming development release. Future production
releases require a separate retention decision.

Central grants authorize the exact action-type name, grantor, and grantee.
Select one catalog entry and use its name throughout permission and action
submission. Do not derive category mappings from descriptions or broad-sounding
names. Check the live catalog before creating new action intent and validate
the payload using the deployed schema supported by the client. An unsupported
schema must be explicit rather than interpreted as permission to skip checks.

Map only reviewed, bounded server permission rejection details to stable local
errors. Preserve confirmed rejection versus uncertain submission. Bind local
operation state to the current enrollment; central remains authoritative for
permission expiry and remaining uses. Correct reset and pending-answer guidance
without adding a local permission-decision flow.

## Approval and evidence

The user approved the documented follow-up plan, explicitly authorized request
and response body logs during development, then requested implementation with
basic checks followed by live end-to-end testing. Central code remains unchanged.
The reviewed API revision is `708f205bfaee5010eb86fcfae55967fb5d02071c`.
Implementation and qualification progress belong in the implementation plan.
