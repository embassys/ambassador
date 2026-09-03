# 0039 Zero-configuration local start

Status: accepted

Date: 2026-09-03

## Problem

`AMBASSADOR_LOCAL_TOKEN` made the normal direct path harder to install and
configure. It served two unrelated purposes: bearer authentication for a
loopback MCP endpoint and derivation of the central credential encryption key.
Users had to copy the same value into Ambassador and provider MCP setup even
though the process already runs entirely within their local account.

## Decision

The only startup command is:

```text
ambassador start
```

`start` accepts no options. Direct delivery needs no Ambassador environment
variable. Webhook users set their receiver secret in an environment variable
before startup and provide only that variable's name during registration.

Local MCP binds only to `127.0.0.1`. It requires the exact loopback `Host`,
allows no non-loopback `Origin`, rejects an `Authorization` header, and applies
all request limits before dispatch. It does not use bearer authentication. The
accepted trust boundary is the owner's local machine and account: another
process running as that owner can reach or impersonate a supported MCP client.
Host and Origin checks still block DNS rebinding and ordinary cross-origin
browser requests; they are not process authentication.

Ambassador generates 192 bits of random credential-wrapping material and
stores it in a separate owner-only state file beside the encrypted central
credential. The value never enters CLI arguments, environment variables, MCP,
ACP, logs, or diagnostics. Strict ownership, link, permission, format, and
atomic-write checks apply to both artifacts; authenticated-envelope checks
continue to protect the encrypted credential.

This protects the token and DPoP private key from accidental disclosure of the
credential file alone. It does not protect them from a process that can read
the owner's complete Ambassador state directory. Stronger same-user isolation
would require an operating-system credential service and a separately approved
cross-platform design.

There is no migration. A credential file without its matching internal key
fails closed. Development users may remove the complete old state and enroll
again.

ACP session MCP injection carries only the loopback URL. Provider-side MCP
configuration likewise uses the URL without a bearer token.

## Consequences

- Normal installation is one command plus provider MCP configuration.
- Agents never receive or manage an Ambassador local token.
- Webhook remains the only mode that needs a user-configured Ambassador secret.
- The local-machine trust boundary is simpler but weaker against another
  process already running as the same user.
- The encrypted credential and its wrapping key must be backed up or removed
  together.

## Approval

The user approved the CLI, local MCP, internal key-custody, documentation, and
0.2.7 release changes on 2026-09-03.
