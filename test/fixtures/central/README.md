# Central REST fixture

This independent Python service models the unversioned REST contract in ADR
0037. It implements email enrollment, P-256 key binding, 30-day HS256 test
tokens, Bearer authorization with a separate ES256 DPoP proof, permissions,
action calls, consuming message polling, permission listing, and
target-authorized action results with correlated response messages, and
acknowledgement.

The service has no gateway central-MCP implementation, version negotiation,
activation, reissue, lease, general conversation or reply, outcome lookup, or
migration behavior.

`cryptography==50.0.0` verifies proof signatures independently from the
gateway. Test controls require the isolated `A2A_TEST_CONTROL_TOKEN` value and
are not part of packed gateway artifacts.
