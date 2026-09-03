# 0044 Local clean command

Status: accepted

Date: 2026-09-03

## Problem

Repeating an Ambassador registration test requires deleting the complete local
state. The manual process is easy to get wrong. Deleting only the delivery
profile, encrypted credential, or wrapping key leaves invalid partial state,
and removing the wrong directory can damage unrelated data.

The reset must not imply a server-side unregister operation. Central still
owns the registered email identity after local files are gone. Ambassador also
does not own the agent's MCP setup, provider credentials, Hermes webhook route,
OpenClaw hooks configuration, or Mailosaur account.

## Decision

Add this public command:

```text
ambassador clean
```

It accepts no options or positional values. The command itself is the owner's
explicit authorization to delete local Ambassador enrollment and delivery
state, so it does not add an interactive prompt or a force flag.

Before deleting anything, `clean` acquires the existing singleton process lock.
It fails without changing state if `ambassador start` is running or the lock
artifact cannot be validated. While it owns the lock, it removes every entry
from the private Ambassador state directory except the lock database and its
active SQLite sidecars. The removed entries include:

- the encrypted central credential and wrapping key;
- the encrypted webhook secret and wrapping key;
- the delivery profile;
- the ID-only notification journal and its SQLite sidecars; and
- interrupted temporary writes and future files inside the product-owned state
  directory.

Keep the empty owner-only state directory and singleton lock. Retaining that
content-free coordination artifact avoids a race where a new foreground
process could create state while cleanup was deleting the directory. A second
`clean` call succeeds and produces the same result.

The command does not call central or inspect, change, or delete provider state.
It prints only `Ambassador local state cleared` after success and never prints
the state path or deleted values. Users must not run `webhook-secret`
concurrently with cleanup because ADR 0042 deliberately allows that command to
run outside the foreground process lock.

## Security

The derived platform state path remains fixed. Test-only path injection is not
a CLI option. Acquiring the process lock validates that the state root is a
real private directory before cleanup. Nested symbolic links are removed as
links and are not followed. A lock conflict or invalid artifact returns a safe
bounded error and leaves the state untouched.

The command removes credentials rather than decrypting them. No credential,
secret, registration email, message body, prompt, or provider output enters
stdout, stderr, logs, or another file.

## Consequences

- The next `ambassador start` exposes `register_agent`, `verify_email`, and
  `resend_verification` as it does on a new installation.
- The old central registration still exists. A repeat without server-side
  cleanup needs a new disposable email address.
- Provider-specific test configuration remains the owner's responsibility.
- A corrupt or untrusted lock artifact requires the existing manual reset after
  the owner verifies the exact path and confirms no process is running.

## Approval

On 2026-09-03, the user requested one CLI command that deletes local Ambassador
test residue so the next start behaves like a new installation. The user had
already clarified that no server-side cleanup is needed.
