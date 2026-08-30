# A2A Claude connector

This private package contains the provider-neutral connector foundation and the
Claude command entrypoint. It does not yet select or qualify a Claude provider
interface, and it is not approved for publication.

The foreground command is:

```text
a2a-claude-connector start --webhook-port=<port> --webhook-token-env=<name> --working-directory=<absolute-directory> --policy=<read-only|workspace-write>
```

The gateway must be running on `127.0.0.1:8787`. Put its 48-character
lowercase hexadecimal webhook token in the named environment variable. The
connector accepts authenticated webhook wakes only on the selected loopback
port.

To retire all Claude correlation state for the current account, use the
separate confirmed command described in the project architecture. Retirement
is permanent for the version 1 state location.
