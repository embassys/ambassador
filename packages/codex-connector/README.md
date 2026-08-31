# A2A Codex connector

This private package contains the provider-neutral connector foundation and the
Codex command entrypoint. ADR 0034 selects Codex App Server `0.149.0`, and CX03
implements that adapter against the fake selected interface. CX04 supplies an
offline manual qualification runner, but no real authenticated Codex run has
succeeded. The package has no provider or platform support claim and is not
approved for publication.

The foreground command is:

```text
a2a-codex-connector start --webhook-port=<port> --webhook-token-env=<name> --working-directory=<absolute-directory> --policy=<read-only|workspace-write>
```

The gateway must be running on `127.0.0.1:8787`. Put its 48-character
lowercase hexadecimal webhook token in the named environment variable. The
connector accepts authenticated webhook wakes only on the selected loopback
port.

Provider-neutral setup, policy, history, retention, and retirement guidance is
in [connector setup and retention](../../docs/connector-setup-and-retention.md).

To retire all Codex correlation state for the current account, use the
separate confirmed command described in the project architecture. Retirement
is permanent for the version 1 state location.
