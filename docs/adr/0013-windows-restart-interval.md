# 0013 Windows restart interval

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

Supersedes the Windows restart-delay value in ADR `0010-user-services.md`.

## Problem

ADR 0010 selected a five-second restart delay on every platform. Windows Task Scheduler's `RestartOnFailure/Interval` schema has a minimum value of `PT1M`, so `PT5S` is rejected when the task is registered.

## Decision

Use Task Scheduler's native restart-on-failure policy with a one-minute interval and 255 attempts. Keep the five-second delay for launchd and systemd.

The Windows task remains per-user, runs with `InteractiveToken` and `LeastPrivilege`, starts at user logon, and does not embed credentials.

## Costs

A crashed Windows sidecar can remain down for up to one minute. A shorter interval would require a separate supervisor process or Windows service, both outside the per-user, no-elevation v1 design.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
