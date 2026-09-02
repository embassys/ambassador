# Current work

The central REST and DPoP integration is implemented and live-qualified. The
next work is one clean delivery cutover to the accepted Ambassador design in
ADR 0038. There is no compatibility or migration requirement for development
state, the old package name, the old CLI, ID-only wakes, or connector packages.

## 1. Red specifications and package boundary

- Change package expectations from `@a2adev/gateway` to
  `@embassys/ambassador` and from `a2a-gateway` to `ambassador`.
- Specify `ambassador start --local-token-env=<name>` and rejection of the old
  webhook startup flags, agent flags, secret-value flags, and unknown options.
- Specify atomic delivery-profile storage with no secret or message content.
- Specify canonical startup-directory capture and rejection of a conflicting
  direct-mode restart directory.
- Add a delivery-target interface that has webhook and direct fakes.
- Keep all existing central REST and DPoP contract tests green.

## 2. Guided MCP registration

- Retain MCP initialization `clientInfo` as a bounded per-session hint.
- Extend `register_agent` with the optional delivery union in the protocol.
- Return structured `input_required` results until the user supplies all local
  delivery choices.
- Validate and persist the delivery profile before contacting central.
- Reject raw secret values and credential-shaped fields before dispatch.
- Remove local `poll_messages` and `ack_message` from the post-enrollment MCP
  catalog once automatic delivery owns acknowledgement.

## 3. Webhook delivery

- Replace the ID-only wake with the complete canonical message body.
- Allow HTTPS endpoints and literal-loopback HTTP endpoints. Reject URL
  credentials, fragments, unsupported schemes, and other plaintext remote
  targets.
- Resolve the webhook secret directly from its configured environment-variable
  name. Never return, log, or persist it.
- Keep bearer authentication, HMAC V2 signing, request IDs, idempotency keys,
  deadlines, bounded retries before acceptance, and body limits.
- Treat `2xx` as transfer of custody and then acknowledge central. Do not wait
  for a later MCP poll or acknowledgement.

## 4. Direct ACP v1 delivery

- Add exact `@agentclientprotocol/sdk` 1.4.0 and record its license in the
  existing dependency audit.
- Implement a gateway-owned ACP client, child lifecycle, fixed supported-agent
  profiles, and safe environment handling.
- Supply Ambassador MCP to ACP sessions that accept session MCP configuration.
  Require provider-side MCP setup where they do not.
- Submit a fixed instruction plus the complete validated message as one ACP
  prompt.
- Acknowledge central only after a successful terminal ACP result.
- Do not automatically replay after prompt dispatch when completion is
  uncertain.
- Keep provider output, prompts, message bodies, credentials, and secrets out
  of durable state and observability.

## 5. Remove the superseded implementation

- Remove connector packages, connector scripts, connector fixtures, and the
  old provider-specific transport code.
- Remove the old package and binary names without aliases.
- Remove ID-only wake text and delivery-control MCP paths.
- Remove obsolete setup and qualification documents after their useful history
  is represented by ADR 0038 and the ADR ledger.
- Scan the built package for old names, retired commands, message content, and
  credential markers.

## 6. Qualification

### Required in CI

- Run the full central fixture matrix.
- Run webhook delivery against a mock receiver that validates the complete
  body, bearer, HMAC, timestamp, idempotency, retry, and acknowledgement order.
- Run direct delivery against a mock ACP v1 agent that validates initialize,
  session setup, MCP configuration, full-message prompt, terminal success,
  failure, cancellation, crash, and uncertain-outcome handling.
- Prove both modes obey queue, body, deadline, concurrency, shutdown, and
  no-content-persistence limits.

### Required as opt-in local qualification

Run real OpenClaw and Hermes against the local central fixture in this matrix:

| Agent | Webhook | Direct ACP |
| --- | --- | --- |
| OpenClaw | required | required |
| Hermes | required | required |

Each run uses an isolated account/profile, synthetic message data, a bounded
working directory, normal provider authentication, and the exact candidate
package. Record provider and adapter versions plus pass/fail evidence, but no
prompts, messages, credentials, or secret values.

Codex and Claude may be added to the same matrix after their ACP adapters are
implemented. They do not block the first OpenClaw and Hermes qualification.

### Required before publication

- Pass Linux and macOS CI and packed-package installation.
- Pass all four OpenClaw/Hermes local real-agent cases.
- Rerun controlled live central qualification against the current server.
- Review dependency, license, provenance, and artifact scans.
- Update setup instructions with the exact qualified version.
- Obtain explicit publication approval.

Windows remains unsupported under ADR 0033. Optional central service changes
remain in [Central follow-ups](central-follow-ups.md) and do not authorize
client-side compatibility code.
