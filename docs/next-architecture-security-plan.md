# Architecture and security follow-ups

Status: current follow-up plan after ADR 0037

The immediate architecture is defined in the protocol and implementation
plan. This page keeps improvements that may be valuable after the current REST
integration works. None of them changes I02 through I05 without a new reviewed
decision.

## 1. Complete the current live path

- Replace fixtures and tests first.
- Delete both obsolete central clients.
- Implement the pinned REST request shapes and deployed DPoP behavior.
- Run a two-identity permission/action E2E.
- Scan durable state, logs, temporary files, and packages for content and
  credentials.

This work adds no dependency, public CLI option, API version, migration path,
or central MCP transport.

## 2. Improve message recovery

Current polling marks a message delivered before the gateway can make its body
durable, and the gateway intentionally does not persist bodies. A crash can
therefore lose work.

The preferred future fix is server-side retrieval or redelivery. Any proposal
must define duplicate behavior, acknowledgement idempotency, bounds, and a
safe rollout. Until it exists, the client documents the limitation and keeps
the journal ID-only.

## 3. Improve credential lifecycle

The current token lasts 30 days and has no refresh or reissue endpoint. A
future design may add revocation and deliberate recovery. It must keep the
private key local and must never interpret an ordinary `401` as permission to
replace the identity.

The current development client uses fresh enrollment after intentional local
cleanup. It carries no old-format migration code.

## 4. Harden server observability and contracts

- Repair generated OpenAPI.
- Add build metadata to health.
- Bound and sanitize server errors.
- Restore verification-code expiry.
- Add route tests for action schemas, permission listing, invitation behavior,
  and expiring permissions.

These changes improve confidence without changing the gateway architecture.

## 5. Rebase provider connectors

The existing provider execution state machine assumes central conversation and
reply operations. After the live permission/action flow works, decide which
message types should invoke a provider and how a provider records success
using actual REST operations.

Preserve these boundaries during that redesign:

- no provider credentials in the gateway;
- no central credentials in the connector;
- no prompt, message, action payload, or reply in connector durable state;
- no automatic approval or policy widening; and
- no blind replay after an uncertain provider outcome.

Update connector tests before implementation and rerun real-provider
qualification afterward.
