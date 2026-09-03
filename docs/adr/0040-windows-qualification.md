# 0040 Reopen Windows qualification

Status: accepted plan; Windows support remains a candidate

Date: 2026-09-03

## Problem

ADR 0033 excluded Windows because the project had no native evidence for state
security, SQLite, process containment, delivery, or the packed npm artifact.
The package now needs a Windows release lane and an explicit route to a support
claim.

## Decision

Add `windows-latest` to the deterministic and packed-package CI matrices. A
portable test pass is not enough. The Windows jobs must exercise the installed
tarball and the native operating-system behavior.

Windows state uses a fixed encoded Windows PowerShell 5.1 program to replace
inherited access rules with a protected DACL. The DACL grants full control only
to the current user's SID and SYSTEM, sets the current user as owner, rejects
reparse points, and verifies the applied owner and rules. Ambassador locates
PowerShell below the validated absolute `SystemRoot`; paths pass through a
bounded child environment rather than script text. The credential, internal
key, delivery profile, process lock, notification journal, and SQLite sidecars
all sit below a directory with this DACL. Files also receive an explicit file
DACL.

Windows npm command shims are batch files and cannot be launched by Node
without a shell. Ambassador does not execute those shims. For reviewed Node
agents, the capability registry fixes the package name, package version, bin
name, and JavaScript entrypoint. Ambassador searches only package roots next
to an absolute `PATH` entry, checks the exact package metadata, resolves the
entrypoint inside that package, and launches it with Ambassador's current Node
executable. Native agent executables continue to use the fixed registry
command. Neither path accepts an executable or argument from MCP input.

Windows direct delivery still needs native process-tree cleanup evidence. No
Windows direct-agent support claim is permitted until that cleanup mechanism
is separately approved and its cancellation, crash, and descendant tests pass
on the Windows runner. A real agent and mode may be claimed on Windows only
after its exact packed-artifact qualification passes there.

Windows support requires all of these results from one candidate:

1. native owner and SYSTEM DACL tests for every state artifact;
2. lock contention, crash handoff, SQLite WAL, corruption, and restart tests;
3. loopback MCP and complete-message webhook tests;
4. ACP startup, cancellation, uncertain-outcome, and descendant cleanup tests;
5. packed installation, Windows command-shim launch, and forbidden-marker
   scans; and
6. a real supported-agent run for each profile and mode claimed on Windows.

No dependency is added. Any new Windows API or system executable beyond the
accepted DACL helper needs separate user approval.

## Consequences

The Windows CI jobs are release gates once enabled. A failing Windows job
blocks publication. The package can gain Windows webhook support before an
individual direct-agent profile qualifies, but documentation must state that
profile and mode distinction.

ADR 0033 becomes a historical record. Its evidence requirements remain in the
list above rather than disappearing with the deferral.

## Approval

The user approved reopening Windows work and the qualification plan on
2026-09-03. The user then asked for the candidate to be raised as a pull
request. The approval does not cover a new process-tree termination API or a
Windows direct-agent support claim before native evidence exists.
