# 0020 In-memory central test service

Status: accepted; fixture use amended by ADR 0038

Date: 2026-08-25

Updated: 2026-09-02

## Problem

Ambassador integration tests need the central REST boundary without PostgreSQL,
email delivery, external credentials, or a public service. Cryptographic tests
should not share the production verifier.

## Decision

Maintain two independently implemented test services:

- a fast Node fixture for most tests; and
- a Python container fixture using the already approved test-only
  `cryptography==50.0.0` wheel.

Both implement the current unversioned REST contract. Their exact behavior is
documented beside the fixture code in `test/fixtures/central/`. They hold all
identities, codes, keys, tokens, permissions, action schemas, and messages in
memory. Restarting a fixture clears state unless the test harness explicitly
preserves its backing process for a crash barrier.

The Python fixture computes JWK thumbprints and verifies ES256 proofs
independently. It does not copy the Ambassador implementation or central server
source.

Fixtures expose deterministic test-only controls for time, verification code,
action definitions, permissions, queued messages, and response-loss barriers.
Those controls bind only to the isolated test environment and are absent from
packed artifacts.

No fixture implements central MCP, bearer-only Ambassador credentials,
`/api/v2`, activation, token reissue, leases, conversations, replies, outcomes,
or migration.

## Scope

Fixture success proves Ambassador behavior against the test profile. It does not
prove live email delivery, proxy behavior, deployment identity, production
replay state, database transactions, capacity, or server uptime.

ADR 0038 reuses these fixtures for deterministic webhook and ACP delivery
tests. The mock webhook receiver and mock ACP agent are separate test peers and
do not change the central fixture contract.

## Approval

The user approved the in-memory fixture strategy on 2026-08-25, independent
fixture cryptography on 2026-08-29, the current REST amendment through ADR 0037
on 2026-09-01, and delivery-mock use through ADR 0038 on 2026-09-02.
