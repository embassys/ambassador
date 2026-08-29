# 0027 Fresh-install version 2 cutover

Status: accepted

Date: 2026-08-29

Approved: 2026-08-29

## Problem

ADRs 0023, 0025, and 0026 included migration paths for an installed gateway
with a version 1 credential, an existing central identity, or queued version 1
messages. The product is not required to upgrade an installed version 1 user.
Keeping those paths would add credential replacement states, legacy bearer
handling, mailbox migration, rollout coordination, and recovery cases that do
not serve the intended launch.

The shipped current API still needs an accurate regression baseline, and the
future version 2 API still needs a complete target contract. Those are two
release contracts, not two modes that one gateway process must negotiate.

## Decision

Treat the version 2 gateway as a fresh-install cutover.

- The existing test suite continues to describe and protect the currently
  shipped API.
- T03, T04, and the future implementation target only a fresh installation
  with no existing gateway credential, journal, mailbox, or enrolled central
  identity that must be converted.
- The version 2 release does not read, convert, replace, or revoke a version 1
  credential. It does not migrate version 1 mailbox rows or delivery state.
- The gateway does not select between current and future contracts at runtime.
  It adds no version flag, capability discovery, route probe, legacy fallback,
  or migration state.
- Fresh version 2 enrollment may use the fixed idempotent activation operation,
  but activation is not a mailbox migration. Tests do not require
  `migration_incomplete` or transition an identity with version 1 rows.
- Same-key reissue, revocation, and email-control recovery remain part of the
  future credential lifecycle after fresh enrollment. They are not migration
  mechanisms.

This record supersedes only the migration and in-place-upgrade requirements in
ADRs 0023, 0025, and 0026. Their REST, DPoP, credential-v2, activation,
conversation, delivery, recovery, and security contracts otherwise remain
accepted.

## Consequences

The gateway and central implementations are smaller and have no mixed-version
credential or mailbox state machine. Test fixtures may retain version 1 data
to protect the shipped baseline, but T03 and T04 must not present that data as
a version 2 migration requirement.

The version 2 release requires a clean gateway state and a new version 2
enrollment. Distribution and release notes must state that boundary before the
future release ships. Supporting an in-place upgrade later requires a new ADR,
new red tests, and explicit user approval.

This decision does not supply production URLs, central deployment facts, or
permission to enable DPoP before central enforces it.

## Alternatives considered

- **Migrate version 1 credentials and mailboxes in place.** Rejected because it
  adds security-sensitive replacement and mixed-delivery states that are not
  required for the launch.
- **Probe central and choose a protocol dynamically.** Rejected because it can
  duplicate side effects, weakens downgrade resistance, and conflicts with the
  fixed single-gateway architecture.
- **Add a user-facing version option.** Rejected because the CLI remains the
  approved two-option foreground interface and runtime configuration is out of
  scope.

## Approval

The user approved the fresh-install assumption on 2026-08-29 and asked that
the repository cover the shipped current API and the desired future API, with
no migration between them.
