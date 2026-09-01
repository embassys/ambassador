# Architecture overview

Status: current human overview as of 2026-09-01

## One development architecture

The gateway has one central target: the unversioned REST API at
`https://mcp.embassys.ai`, as implemented by `embassys/agent2agent` commit
`b769896b7cfb1ee3540195be9e7a61cf777b9388`.

The current target does not use central MCP, `/api/v2`, token reissue,
activation, leases, free-text conversations, replies, or migration. The
published bearer-only gateway and the repository's speculative versioned
implementation are both superseded. The next code changes replace them rather
than preserving compatibility.

## System shape

```text
human or local agent runtime
          |
          | authenticated loopback MCP
          v
gateway on 127.0.0.1:8787
          |
          | REST bootstrap
          | Bearer token plus DPoP proof after verification
          v
Embassys REST API
          |
          | consumed message batch
          v
gateway bounded memory plus ID-only journal
          |
          | authenticated ID-only webhook wake
          v
local webhook or optional provider connector
```

One gateway owns one central identity and one webhook target. The gateway stays
provider-neutral.

## Trust and custody

| Component | Owns | Does not own |
| --- | --- | --- |
| Central | Email identities, public DPoP keys, tokens, permissions, action schemas, messages, and acknowledgements | Local webhook or provider credentials |
| Gateway | Local MCP authentication, encrypted central token and private key, proof creation, bounded message memory, and ID-only wake state | Provider credentials, durable message bodies, or runtime selection |
| Local runtime | User interaction, MCP tool use, and message handling | Direct central token handling |
| Optional connector | Webhook admission and provider process control | Central credential or message-body persistence |
| Provider runtime | Its own authentication, history, tools, and model execution | Gateway state |

The central token and P-256 private key persist only inside one encrypted
credential file. Gateway SQLite contains only opaque message IDs and relay
state. Action payloads, messages, permissions, emails, codes, proofs, and MCP
bodies stay out of durable gateway state and observability outputs.

## Main flows

### Startup

1. Acquire the singleton lock.
2. Resolve the named local webhook token.
3. Bind authenticated MCP on `127.0.0.1:8787`.
4. Load the current encrypted credential, if one exists.
5. Start REST polling only when the credential is valid and unexpired.
6. Print the MCP endpoint and remain in the foreground.

The gateway takes exactly `--webhook-url` and `--webhook-token-env`. It has no
central URL, version, provider, migration, or verbose-transcript option.

### Enrollment

1. `register_agent` sends email and optional display name to
   `/api/register_agent`.
2. The user receives a verification code by email.
3. `verify_email` creates a P-256 key and sends its public JWK in the JSON body.
4. Central returns a token bound through `cnf.jkt`.
5. The gateway validates the binding and atomically stores the token and
   private key.
6. Local MCP returns token-free success and enables protected REST tools.

### Protected REST

Each request uses `Authorization: Bearer <token>` and a separate ES256 DPoP
proof. The proof binds the token, method, and exact URL. It gets a new `jti`
and timestamp for each request. The client includes a nonce only after the
server supplies one.

The gateway exposes fixed REST-backed tools for action discovery, permission
requests and decisions, action delivery, message polling, permission listing,
and acknowledgement.

### Message receive and wake

1. The gateway long-polls `/api/poll_messages`.
2. Central marks returned rows delivered.
3. The gateway validates a bounded batch and keeps bodies in memory.
4. It journals present IDs and sends an ID-only authenticated webhook wake.
5. The local agent retrieves the body through local MCP.
6. After processing an ID-bearing message, the local agent acknowledges it.
7. The gateway deletes local state only after central confirms `acked`.

The server does not lease or redeliver delivered messages. A gateway crash can
lose a body that central already returned. This is an explicit development
limitation.

## Provider connectors

The provider-neutral connector, Codex adapter, and Claude adapter have local
fixture coverage. Their common execution contract assumed central
conversation, reply, completion, and outcome routes. Those routes do not exist
on the current server.

Provider process isolation, local policy, credential separation, and
content-free state remain useful. Live connector integration is paused until
the gateway's permission/action message behavior is working and the connector
flow is redesigned around that behavior. It is not a blocker for the gateway
REST switch.

## Failure behavior

| Failure | Gateway behavior |
| --- | --- |
| Wrong local bearer, Host, or Origin | Reject before body parsing |
| Verification persistence fails | Return uncertainty and expose no token |
| Missing DPoP proof, wrong key, or replay | Fail the protected operation; do not replace the credential |
| Server supplies a nonce | Retry once with a fresh proof and that nonce |
| Central redirect | Reject it |
| Side-effecting response is lost | Report uncertainty; do not retry automatically |
| Poll response is lost after central delivery | Message may be lost under the current server contract |
| Gateway restarts with stale IDs | Remove stale wake state because no body is recoverable |
| Action catalog changes | Treat the returned schema as data and update the pinned fixture deliberately |
| Credential is expired or unreadable | Fail closed; use a clean development enrollment after intentional local cleanup |

## Release boundary

The current code has not completed the switch described here. A live
compatibility claim requires:

- replacement tests and fixtures for the pinned REST contract;
- deletion of old bearer/MCP and speculative versioned paths;
- the pinned six-action catalog and generated OpenAPI;
- two-identity permission, action, poll, and acknowledgement E2E;
- packed-install and artifact scans; and
- explicit publication approval.
