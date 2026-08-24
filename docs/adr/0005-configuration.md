# 0005 Configuration

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The CLI and daemon need one versioned configuration that works on macOS, Linux, Windows, and in tests. It must identify secrets without storing them.

## Options

- JSON has strict syntax and built-in parsing.
- YAML is easier to edit by hand but adds a parser and has more implicit types.
- TOML is readable but also adds a parser and maps nested adapter settings less directly.

## Decision

Use strict JSON with this shape:

```json
{
  "version": 1,
  "controller": {
    "base_url": "https://controller.example",
    "token": {"source": "env", "name": "A2A_CONTROLLER_TOKEN"},
    "poll_wait_seconds": 30,
    "max_notifications": 50,
    "queue_capacity": 1000
  },
  "agents": [
    {
      "binding_id": "binding_hermes",
      "adapter": {
        "type": "generic",
        "url": "http://127.0.0.1:8644/webhooks/a2a",
        "secret": {"source": "env", "name": "A2A_HERMES_SECRET"}
      }
    }
  ]
}
```

Reject unknown fields and duplicate binding IDs. The first implementation supports environment references. A later implementation may add files with strict permission checks or OS credential-vault references.

Write configuration through an atomic temporary-file rename. On POSIX systems, create files and directories for the owning user only.

Default directories follow each operating system:

| OS | Configuration and state root |
| --- | --- |
| macOS | `~/Library/Application Support/a2a-sidecar/` |
| Linux | `$XDG_CONFIG_HOME/a2a-sidecar/` for config and `$XDG_STATE_HOME/a2a-sidecar/` for state |
| Windows | `%APPDATA%\a2a-sidecar\` for config and `%LOCALAPPDATA%\a2a-sidecar\` for state |

Tests and commands may override the config path with `--config` or `A2A_CONFIG_PATH`.

Before its first wake attempt, the sidecar records a fingerprint of the selected binding's non-secret configuration and secret reference. It does not hash or store the secret value. A changed fingerprint after an uncertain attempt blocks rerouting that delivery.

## Costs

JSON does not allow comments. The setup command owns routine edits so users do not need to hand-edit most files.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
