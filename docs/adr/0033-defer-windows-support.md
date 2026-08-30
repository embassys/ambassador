# 0033 Defer Windows support for the initial release

Status: accepted

Date: 2026-08-30

## Problem

The gateway and connector plans included Windows qualification work, but the
native credential, state, process-containment, and packed end-to-end evidence
does not exist. Keeping a Windows CI subset does not qualify those boundaries
and risks presenting portable test results as operating-system support.

## Decision

The initial gateway and connector release supports macOS and Linux only.
POSIX permissions, durability, replacement, process, and packaging behaviors
form the normative release contract. Windows is unsupported and is excluded
from the GitHub Actions matrix, release artifacts, setup instructions, and
support claims.

Implementation-plan task W01 is closed as **deferred**, not passed. It supplies
no release evidence and is no longer a dependency of R01. K02 and later
connector work must not add a Windows lane under the initial-release plan.

Existing Windows branches and platform-neutral tests may remain in the source
tree when they fail closed. Their presence is defensive code, not a support
promise, qualified implementation, artifact target, or substitute for native
Windows evidence.

## Re-enabling Windows

Windows support requires a new user-approved implementation and qualification
plan before code or CI changes. At minimum it must restore a native Windows CI
lane and qualify, on the exact release artifact:

1. credential DACL enforcement and atomic first write and replacement;
2. connector state ownership, DACL, link, SQLite, durability, retirement, and
   recovery behavior;
3. provider process-tree containment, cancellation, crash recovery, and
   bounded teardown;
4. clean packed installation and the complete gateway, connector, and fake
   provider end-to-end lifecycle; and
5. artifact scans and support documentation for every claimed Windows target.

The new plan must resolve any required native API or dependency choice before
installation. Passing portable tests or re-adding `windows-latest` alone does
not reopen support.

## Consequences

The supported initial platform matrix is smaller and CI no longer detects
portable Windows regressions. Release evidence is clearer: macOS, Linux,
Ubuntu Docker, and the approved package lanes are the only platform evidence.
Windows users receive no artifact or support claim.

This record supersedes the initial-release Windows portions of ADRs 0006,
0015, 0019, 0025, 0026, 0029, 0031, and 0032. Their Windows-specific security
requirements remain the minimum future qualification target; they are not
implemented-release requirements while Windows is deferred.

This decision changes no CLI, dependency, credential format, state schema, or
production behavior.

## Approval

Approved by the user on 2026-08-30. The user explicitly deferred Windows and
requested that current implementation and release work continue without it.
