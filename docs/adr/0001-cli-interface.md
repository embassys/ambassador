# 0001 CLI interface

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The same command must support interactive setup, scripts, foreground development, and a background user service. Tests will lock command names and output, so the shape must be recorded before test work starts.

## Options

- Flat commands such as `a2a agent-add` are easy to parse but become noisy as the CLI grows.
- Grouped commands such as `a2a agent add` keep related work together.
- A setup wizard alone is friendly for first use but poor for CI and managed machines.

## Decision

Use the binary name `a2a` with grouped commands:

```text
a2a setup
a2a agent add <binding-id>
a2a agent list
a2a agent remove <binding-id>
a2a agent test <binding-id>
a2a run
a2a status
a2a doctor
a2a service install
a2a service start
a2a service stop
a2a service restart
a2a service status
a2a service uninstall
a2a version
```

`setup` is interactive by default and accepts flags for unattended use. `run` keeps the daemon in the foreground for development and containers. Service commands manage a per-user service.

All commands accept `--config <path>`. Read-only commands accept `--json`. Commands that change state also support `--json` when every required value is passed as a flag.

Machine output uses one of these shapes:

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"config_invalid","message":"Configuration is invalid"}}
```

The JSON error message is safe for display and never includes secrets or raw remote responses.

Stable exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Invalid command or arguments |
| `3` | Missing or invalid configuration |
| `4` | Authentication failure |
| `5` | Controller network failure |
| `6` | Local runtime failure |
| `7` | Local state or service failure |
| `70` | Unexpected internal error |

Secrets are never accepted as literal command-line flags. Setup stores environment-variable or file references. A controller login command remains deferred until the controller authentication flow is defined.

## Costs

Grouped commands require a little more parsing. Deferring login means the first development version uses an existing installation token reference rather than a browser or device flow.

## Packaging impact

The command interface does not require a CLI framework. A standalone build must preserve the binary name and exit codes.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
