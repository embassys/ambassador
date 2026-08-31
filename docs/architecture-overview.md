# Architecture overview

Status: concise human overview as of 2026-08-31

This page explains the whole system and maps its failure behavior. The exact
contracts remain in the [protocol](protocol-v1.md), accepted
[ADRs](adr/README.md), and reviewed test inventories.

## Product states

There are two product states in this repository.

The shipped `0.2.6` gateway matches the current central service. It stores a
bearer credential, uses the consuming notification interface, and can lose an
in-memory message after a crash because central cannot redeliver it.

The accepted version 2 target uses DPoP-bound credentials, fixed REST
enrollment, leased central delivery, idempotent replies, and separate
acknowledgement. Its gateway and connector code passes local fixture tests.
The project owner reports that the central server implements DPoP, but the
exact source revision and deployment have not been identified. The inspected
`embassys/agent2agent` default branch and hosted routes still expose the older
bearer contract. The provider connectors are also unreleased.

Never mix the two states at runtime or cite target tests as evidence for the
shipped service.

## System shape

```text
human or local agent runtime
          |
          | authenticated loopback MCP
          v
gateway on 127.0.0.1:8787
          |
          | REST bootstrap, then DPoP REST and MCP
          v
central service
          |
          | leased version 2 message
          v
gateway in-memory inbox and ID-only journal
          |
          | authenticated ID-only webhook wake
          v
provider connector on 127.0.0.1
          |
          | retrieve, reply, complete, and acknowledge through gateway MCP
          | provider protocol over a dedicated child process
          v
Codex or Claude provider runtime
```

One gateway owns one central identity and one webhook target. One connector
owns one provider, one canonical working directory, and one encrypted
correlation store. Supporting another provider requires another gateway and
connector pair.

## Ownership and data custody

| Component | Owns | Must not own |
| --- | --- | --- |
| [Central service](https://github.com/embassys/agent2agent) | Identities, full messages, conversations, leases, replies, outcomes, acknowledgements, token issuance, and revocation | Local provider credentials or connector state |
| Gateway | Local MCP authentication, encrypted central credential, DPoP proofs, bounded message memory, ID-only wake state, and central clients | Provider credentials, provider history, durable message bodies, or runtime selection |
| Connector | Authenticated webhook admission, encrypted opaque correlation IDs, lifecycle state, bounded retry timing, and provider process control | Message text, replies, tool data, credentials, provider history, or plaintext working-directory paths |
| Provider runtime | Its own login, content-bearing history, tools, model execution, and provider protocol | Central credential or gateway state |
| Local runtime or human | Gateway MCP use, enrollment input, and any provider-owned approval decision allowed by the provider contract | Direct central token handling |

The central credential and P-256 private key may persist only in the gateway's
encrypted credential file. Gateway SQLite contains opaque notification IDs and
relay state. Connector SQLite contains encrypted opaque correlation IDs and
content-free lifecycle state. Message bodies live at central and in bounded
process memory only.

## Main flows

### Gateway startup

1. Acquire the singleton lock before reading credentials, binding a port, or
   contacting another process.
2. Resolve the named 48-character webhook token.
3. Bind the authenticated local MCP server to `127.0.0.1:8787`.
4. Load and validate the encrypted credential if one exists.
5. Start version 2 delivery only after the credential is valid and central has
   confirmed activation.
6. Print the MCP endpoint and remain in the foreground.

The gateway accepts only `--webhook-url` and `--webhook-token-env`. The shipped
compatibility build also has the temporary, development-only `--verbose=true`
exception.

### Enrollment and activation

1. The local agent calls `register_agent` through authenticated local MCP.
2. The gateway sends the fixed central REST registration request without a
   central access token.
3. For `verify_email`, the gateway creates a P-256 key and signs an issuance
   proof.
4. The gateway validates the returned DPoP token and its public-key binding.
5. It atomically encrypts and publishes the token and private key before it
   reports success.
6. It activates version 2 delivery and then exposes protected work.

Resend is another fixed REST bootstrap call. Registration, verification, and
resend have no central access token, but every local MCP call still requires
the loopback bearer and the Host and Origin checks.

### Receive, run, reply, and acknowledge

1. Central leases a full immutable message to the gateway for 60 seconds.
2. The gateway validates it, keeps the body in memory, and journals only its
   opaque ID.
3. The gateway sends an ID-only webhook wake with bearer, HMAC, and replay
   headers.
4. The connector authenticates the wake, deduplicates it, and retrieves the
   body through gateway MCP.
5. The connector reserves the conversation mapping before provider dispatch.
6. The provider adapter starts or resumes the exact provider session under the
   selected `read-only` or `workspace-write` maximum.
7. The connector records one reply or a reviewed no-reply outcome through the
   gateway.
8. Only after central confirms that terminal result does the connector request
   acknowledgement.
9. The gateway removes the body and journal row only after central returns the
   exact acknowledged result.

Reply before acknowledgement is a hard ordering rule. It prevents a message
from disappearing before its terminal result exists.

### Start an outbound conversation

The authenticated local MCP client supplies the recipient and text. The
gateway sends the fixed idempotent central REST start request. Central owns the
conversation and message IDs. If the response is lost, the client resolves
the attempt by its request ID instead of creating a second conversation.

### Credential reissue and recovery

A version 2 token lasts 24 hours. Scheduled same-key reissue begins with 12
hours remaining. A replacement is accepted only for the same issuer, subject,
audiences, endpoint pair, and P-256 key, with a later expiry and new token ID.

Key loss, expiry, revocation, and deliberate key rotation require the separate
email-control recovery flow. A `401`, proof failure, invalid token, key error,
or ordinary tool failure never starts reissue, registration, or replacement.
An unreadable credential remains untouched until the project approves an
explicit reset interface.

### Crash recovery

Central owns the recoverable message body. If the gateway crashes, the lease
expires and central can return the same immutable message. The gateway clears
stale local wake rows instead of inventing content.

The connector persists the dispatch decision and opaque provider handles. On
restart it may resume or inspect only the exact prior provider turn when the
provider contract proves that operation does not create new work. If it cannot
prove the old outcome, it records uncertainty and never replays the prompt.

Lost reply and acknowledgement responses use central outcome lookup and
idempotent operations. They do not cause another provider turn.

### Provider state retirement

`retire-state --confirm=retire-all-correlation` writes a permanent provider
tombstone and removes only allowlisted connector correlation artifacts. It is
not a repair command. It does not delete provider history, provider login,
gateway state, central messages, or project files. That provider's version 1
state location can never be used again.

## Provider differences

| Provider | Implemented local interface | Recovery boundary | Current gate |
| --- | --- | --- | --- |
| Codex | App Server `0.149.0` over strict stdio JSONL | Bounded exact-turn lookup through `thread/read` | CX04 real authenticated qualification has not run |
| Claude Code | Headless CLI `2.1.251` through a packaged lifetime monitor | Exact session resume, but no exact-turn result lookup after a crash | CL04 real authenticated qualification has not run |
| Gemini | No selected interface | None | ADR 0036 blocks implementation until a compliant stable interface is approved |

Neither implemented adapter grants an approval. Codex approval requests wait
without a response. Claude uses restricted safe mode with `dontAsk` and treats
unsupported control records as failures. Provider-owned history remains under
the user's provider account.

## Edge-case map

| Failure class | Required behavior | Exact coverage |
| --- | --- | --- |
| Wrong local bearer, Host, or Origin | Reject before body parsing or dispatch | Protocol and T03 inventory |
| Malformed, oversized, deeply nested, or credential-bearing input or result | Fail closed within fixed limits and reflect no body | T03, T04, and K02 inventories |
| Duplicate or replayed webhook | Authenticate the exact bytes, reject timestamp replay, and start no second provider turn | K02 inventory |
| Central redirect or uncertain side effect | Do not follow the redirect or repeat an unsafe call; use the operation's explicit lookup when one exists | T03 and T04 inventories |
| Verification response lost after issuance | Report uncertainty; recover only through the approved email-control path | T03 inventory |
| Token rejected or proof fails | Disable protected work and preserve the credential for diagnosis | T03 inventory |
| Credential file unreadable | Do not overwrite, delete, or silently re-enroll | ADRs 0019 and 0026 |
| Gateway crashes with a leased message | Wait for central redelivery; persist no body locally | T04 crash inventory |
| Wake response is lost | Retry the same ID with a fresh timestamp and signature | T04 and K02 inventories |
| Provider may have acted before a turn handle was durable | Mark the conversation uncertain unless exact non-creating recovery proves the old result | K02 and provider inventories |
| Provider asks for approval or broader authority | Grant nothing; wait or fail according to the fixed provider contract | CX02 and CL02 inventories |
| Provider emits malformed or excessive output | Cancel and contain the exact provider process unit; persist no stream content | CX02 and CL02 inventories |
| Provider history is missing | Fail closed; do not create a replacement conversation or replay input | ADRs 0034 and 0035 |
| Reply was committed but its response was lost | Inspect the central outcome and reuse the same idempotent operation | T04 and K04 inventories |
| Acknowledgement was committed but its response was lost | Repeat only the idempotent acknowledgement until the exact result is observed | T04 and K04 inventories |
| Later work arrives for a blocked, uncertain, or closed conversation | Start no provider work and leave the new message open | K02 inventory |
| Connector state is retired, corrupt, full, or on an unqualified filesystem | Fail closed without guessing, eviction, or state relocation | K02 inventory and ADR 0029 |
| Process shutdown or hard crash leaves provider descendants | The provider and platform remain unsupported unless qualification proves containment | CX04 and CL04 procedures |
| Fixture tests pass but production central or provider evidence is absent | Make no compatibility or support claim | ADR 0032 and release gates |
| Windows execution | Reject the support claim; Windows is deferred, not qualified | ADR 0033 |

The complete reviewed inventories are:

- [REST enrollment and DPoP](../test/t03-failure-inventory.md)
- [Conversation and recovery](../test/t04-failure-inventory.md)
- [Connector foundation](../test/k02-failure-inventory.md)
- [Codex adapter](../test/cx02-failure-inventory.md)
- [Claude adapter](../test/cl02-failure-inventory.md)
- [Full-system scenarios and crash barriers](architecture-pr-backlog.md#end-to-end-test-architecture)

## Release boundary

Local fixture coverage is substantial, including cross-language gateway tests,
fake-provider system tests, package scans, and deterministic crash barriers.
It does not close these gates:

- complete latest-server API and flow refresh, including the reported email-
  and phone-request templates, plus DPoP contact-template development E2E, I01
  and I02;
- central owner implementation and staging, S01 through S07;
- real Codex and Claude qualification, CX04 and CL04;
- gateway live qualification and soak, E01 through E03;
- removal of temporary compatibility paths, G05 through G07;
- explicit preview and stable publishing approvals.

See the [server integration status](server-integration-status.md) for the
observed server drift and the [human work queue](human-work.md) for the current
action list.
