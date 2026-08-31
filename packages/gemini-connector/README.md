# A2A Gemini connector

This private package contains the provider-neutral connector foundation and the
Gemini command entrypoint. It has no selected or qualified Gemini provider
interface, and it is not approved for publication.

GM01 evaluated Gemini CLI `0.57.0` and rejected it as a production interface.
Its headless prompt input is not structured, its approval modes cannot enforce
the connector's policy maximum, its sandbox copies stdin into a child process
argument, and hard connector death does not have a proven child-containment
path. [ADR 0036](../../docs/adr/0036-gemini-cli-interface-evaluation.md) records
the exact candidate and findings. GM02 and GM03 remain blocked until a new
stable compliant interface receives user approval.

The foreground command is:

```text
a2a-gemini-connector start --webhook-port=<port> --webhook-token-env=<name> --working-directory=<absolute-directory> --policy=<read-only|workspace-write>
```

The gateway must be running on `127.0.0.1:8787`. Put its 48-character
lowercase hexadecimal webhook token in the named environment variable. The
connector accepts authenticated webhook wakes only on the selected loopback
port.

To retire all Gemini correlation state for the current account, use the
separate confirmed command described in the project architecture. Retirement
is permanent for the version 1 state location.
