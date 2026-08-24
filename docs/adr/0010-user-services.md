# 0010 User services

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The sidecar must start for one signed-in user without an administrator account or an open terminal. Each supported operating system has a different user-service manager.

## Decision

Use native per-user service managers:

| OS | Manager | Installed definition |
| --- | --- | --- |
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/com.a2a.sidecar.plist` |
| Linux | `systemd --user` | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/a2a-sidecar.service` |
| Windows | Task Scheduler at user logon | Per-user task named `A2A Sidecar` |

The service runs `a2a-gateway run --config <absolute path>`. Registration writes a definition but does not embed credentials. Environment-referenced credentials come from the user's service environment until OS credential vault support replaces them.

Use automatic restart after failures with a five-second delay. Do not restart after a clean stop. Capture logs through the service manager instead of writing unrestricted log files.

`a2a-gateway start` registers the sidecar's own definition when needed, then starts or restarts the daemon. Top-level stop, restart, and status commands call the native manager without a shell. Commands pass argument arrays to child processes, so paths and binding IDs cannot become shell syntax.

Service installation is per-user and must not request elevation. A system-wide service is outside v1.

## Costs

The three managers need native CI or clean-machine tests. Containers cannot prove login startup, service environment behavior, or OS-specific status parsing.

Environment references are fragile in graphical login sessions, especially on macOS. Public beta still requires credential-vault support or an encrypted credential handoff that the service manager can access.

## Packaging impact

Standalone archives need a stable launcher path. Upgrades must stop the service or replace files atomically, then restart it. Package managers must not install a second service definition.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
