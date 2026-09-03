# 0033 Defer Windows support for the initial release

Status: superseded by ADR 0040

Date: 2026-08-30

Updated: 2026-09-02

## Problem

Native Windows evidence does not exist for credential and profile ownership,
atomic local state, SQLite, child-process containment, ACP cancellation, or
packed end-to-end delivery. Portable tests are not enough to claim operating
system support.

## Decision

The initial Ambassador release supports macOS and Linux. POSIX permissions,
durability, process handling, and packaging are the normative release contract.
Windows is excluded from release CI, setup instructions, and support claims.

Platform-neutral code may remain when it fails closed. Its presence is not a
qualified Windows artifact or substitute for native evidence.

## Re-enabling Windows

Windows support requires a new user-approved plan. At minimum, the exact packed
artifact must qualify:

1. central credential and delivery-profile DACLs, atomic writes, and ownership;
2. notification journal locking, SQLite, corruption, and durability;
3. local MCP authentication and listener behavior;
4. webhook secret handling and delivery;
5. ACP child process-tree containment, cancellation, crash uncertainty, and
   bounded cleanup;
6. real supported-agent behavior where claimed; and
7. package installation and forbidden-marker scans.

Any required native API or dependency must be approved before installation.
Adding a `windows-latest` job or passing portable tests does not reopen
support.

## Consequences

The initial support matrix is smaller and cannot detect every portable Windows
regression. Release evidence is clearer: only tested Linux and macOS artifacts
support webhook and direct delivery.

This decision changes no CLI, state schema, dependency, or production behavior.

## Approval

The user deferred Windows on 2026-08-30. ADR 0038 applies that decision to the
single Ambassador package and ACP direct mode.
