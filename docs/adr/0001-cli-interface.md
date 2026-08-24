# 0001 CLI interface

Status: accepted

Date: 2026-08-23

Reviewed: 2026-08-24

## Problem

The same command must support interactive setup, scripts, foreground development, and a background user service. Tests will lock command names and output, so the shape must be recorded before test work starts.

## Options

- Flat commands such as `a2a-gateway agent-add` are easy to parse but become noisy as the CLI grows.
- Grouped commands such as `a2a-gateway agent add` keep related work together.
- A setup wizard alone is friendly for first use but poor for CI and managed machines.

## Decision

Use the binary name `a2a-gateway` with grouped agent commands and top-level daemon lifecycle commands:

```text
a2a-gateway setup
a2a-gateway agent add <binding-id>
a2a-gateway agent list
a2a-gateway agent remove <binding-id>
a2a-gateway agent test <binding-id>
a2a-gateway start
a2a-gateway stop
a2a-gateway restart
a2a-gateway status
a2a-gateway run
a2a-gateway doctor
a2a-gateway version
```

One daemon routes work to every registered agent. `start` registers the native per-user service when needed and starts it; when it is already running, `start` restarts it so the current agent configuration is loaded. `stop` stops it without removing its login registration. `restart` starts a stopped or missing service and restarts a running one. Native service installation is an implementation detail, not a separate public command.

`setup` accepts explicit flags. `run` keeps the daemon in the foreground for development and containers.

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

Grouped agent commands require a little more parsing. Hiding native service registration makes `start` do more work, but removes an OS-specific concept from the normal workflow. Deferring login means the first development version uses an existing installation token reference rather than a browser or device flow.

## Packaging impact

The command interface does not require a CLI framework. A standalone build must preserve the `a2a-gateway` binary name and exit codes.

## Approval

The user reviewed and approved this interface on 2026-08-24.
