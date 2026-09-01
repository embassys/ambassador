# Central fixture

Status: current implementation is obsolete; I02 replacement pending

The files in this directory still implement the superseded versioned fixture.
They must not be used as current central compatibility evidence.

I02 replaces them with the contract in
[`docs/central-fixture-profile.md`](../../../docs/central-fixture-profile.md):

- email-only unversioned REST enrollment;
- P-256 public JWK in the verification body;
- 30-day test tokens with `cnf.jkt`;
- `Authorization: Bearer` plus a separate DPoP proof;
- current action, permission, poll, permission-list, and acknowledgement
  routes; and
- consuming message state with no lease or redelivery.

The replacement removes central MCP, bearer-only client behavior, `/api/v2`,
activation, reissue, revocation, conversations, replies, outcomes, and
migration controls.

The Python fixture continues to verify proofs independently with the approved
test-only cryptography dependency. Test controls remain isolated and absent
from packed artifacts.
