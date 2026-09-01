# K02 connector inventory status

Status: local safety coverage retained; central workflow requires redesign

K02 and K03 established useful local connector behavior:

- authenticated loopback webhook admission;
- bounded scheduling and provider output;
- local policy ceilings and no automatic approval;
- encrypted content-free correlation state;
- exact provider-turn recovery where a provider supports it;
- fail-closed uncertainty and process containment;
- environment scrubbing and artifact scans; and
- strict startup, retirement, limits, and package boundaries.

Those properties remain regression coverage.

The same suite also assumes central conversations, replies, completion,
outcome lookup, and idempotent acknowledgement. ADR 0037 supersedes those
parts. They are not evidence that the connector works with current permission
and action messages.

After I05, C01 must:

1. decide which live message types invoke a provider;
2. define how permission decisions and action handling complete through the
   actual REST tools;
3. rewrite the central-facing K02/K04 cases before connector production
   changes; and
4. preserve the reusable local safety cases above.

Until then, the connector and its provider adapters have no current
live-central support claim.
