# Product and architecture

## Product boundary

The gateway is one foreground process between a local agent runtime and the
Embassys REST service. It exposes an authenticated loopback MCP server,
enrolls one email-based central identity, receives messages for that identity,
and wakes one configured webhook.

The command is:

```text
a2a-gateway start --webhook-url=<url> --webhook-token-env=<environment-variable>
```

The gateway does not discover runtimes, manage bindings, select providers, run
a model, or accept central endpoint configuration. The same local token
authenticates the webhook and every request to the loopback MCP endpoint.

## System

```text
Local agent runtime
  |
  | authenticated loopback MCP
  v
A2A gateway on 127.0.0.1:8787
  |
  | Embassys REST API
  | Bearer token plus DPoP proof after verification
  v
Central permissions, actions, and messages
  |
  | consumed message batch
  v
Gateway bounded memory and ID-only journal
  |
  | authenticated ID-only webhook wake
  v
Configured local webhook
```

An optional provider connector may own the webhook and run a provider. It is a
separate foreground process and never receives the central credential.

## Central service relationship

The central service source is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent), and the live
service is `https://mcp.embassys.ai`. The gateway uses its unversioned REST
API. It does not use central MCP or OAuth.

The gateway follows current server code rather than freezing the architecture
to one server commit. A client-visible server change requires a deliberate
gateway update. Change the protocol, fixtures, tests, implementation, and live
qualification together. Do not probe for alternate contracts or keep the old
client as a fallback.

## Trust and custody

| Component | Owns | Does not own |
| --- | --- | --- |
| Central service | Email identities, public DPoP keys, tokens, permissions, action schemas, messages, and acknowledgements | Local webhook or provider credentials |
| Gateway | Local MCP authentication, encrypted central credential, DPoP proofs, bounded message memory, and ID-only wake state | Provider credentials, durable message bodies, or runtime selection |
| Local runtime | User interaction, MCP tool use, and message handling | Direct central token handling |
| Optional connector | Webhook admission and provider process control | Central credential or message-body persistence |
| Provider runtime | Its own authentication, history, tools, policy, and model execution | Gateway state |

The token and P-256 private key persist only inside one encrypted credential
file. SQLite contains opaque message IDs and relay state. Action payloads,
messages, permissions, emails, verification codes, proofs, and MCP bodies stay
out of durable gateway state and observability output.

## Main flows

### Startup

1. Acquire the singleton lock.
2. Resolve and validate the named webhook token.
3. Bind authenticated MCP on `127.0.0.1:8787`.
4. Load the encrypted central credential if one exists.
5. Start REST polling only when the credential is valid and unexpired.
6. Print the MCP endpoint and remain in the foreground.

### Enrollment

1. The local agent calls `register_agent` with an email and optional display
   name.
2. The gateway registers through the REST API.
3. The user supplies the code delivered by email.
4. The gateway generates a P-256 key and sends its public JWK during
   verification.
5. The gateway validates the returned key binding and timestamps.
6. It stores the token and private key before returning token-free success and
   enabling protected tools.

### Protected work

Each protected REST request carries Bearer authorization and a fresh DPoP
proof for the exact method and URL. The server's action catalog supplies action
names and payload schemas. Permission requests and decisions control whether
an action call may deliver a message to another identity.

### Receive and wake

1. The gateway long-polls central.
2. Central marks queued messages delivered before returning them.
3. The gateway validates a bounded batch, keeps bodies in memory, and journals
   only message IDs and relay state.
4. It sends an authenticated ID-only webhook wake.
5. The local agent retrieves the body through MCP.
6. The local agent acknowledges an ID-bearing message after processing it.
7. The gateway removes the body and ID only after central confirms the
   acknowledgement.

The server cannot currently redeliver a delivered message. A gateway crash
can lose a body that central already returned. Message-body persistence is
still forbidden, so server-side retrieval or redelivery is the proper future
fix.

## Provider connectors

The connector foundation, Codex adapter, and Claude adapter have local fixture
coverage. Their central-facing workflow was designed for conversation and
reply operations that the current server does not have.

Provider process isolation, local policy, credential separation, and
content-free state remain valid. The workflow must be redesigned around
permission and action messages before any connector claims live integration.

## Current limitations

- Central has no message retrieval or redelivery after a consuming poll.
- Central has no token refresh or reissue route. An expired credential requires
  intentional local cleanup and fresh development enrollment.
- Acknowledgement is not idempotent.
- Central currently disables verification-code expiry.
- No provider connector has qualified its current central-facing workflow.
- The published `0.2.6` package predates this implementation.

Potential server improvements live in [Central follow-ups](central-follow-ups.md).
