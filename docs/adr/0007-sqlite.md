# 0007 SQLite

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

The journal needs transactions, unique constraints, migrations, and crash recovery on all supported operating systems.

## Options

- Node 24 includes `node:sqlite`, but its API is still marked release candidate.
- `better-sqlite3` has a mature synchronous API and bundles SQLite, but it adds a native binary to every release target.
- A JavaScript log or JSON file would require us to build locking, transactions, indexes, and corruption recovery.

## Decision

Use `better-sqlite3` 13.0.3 with `@types/better-sqlite3` 9.6.0 and no ORM.

Open one connection and keep transactions short. Enable WAL, `synchronous=FULL`, foreign keys, a busy timeout, and defensive schema constraints. Use prepared statements for every value.

Database work stays synchronous and serialized. The sidecar workload is small, so this is simpler than moving each short transaction to a worker.

## Risks

Version 13 has a recent N-API rewrite. CI must load and exercise the exact package on every target OS. Release builds must include the matching native binary and run clean-machine migration and crash tests.

Synchronous queries block the event loop. Do not add long scans or reporting queries to the daemon.

## Maintenance and license

`better-sqlite3` and its type package use the MIT license. SQLite is public domain.

## Packaging impact

Build release archives on their target operating systems. Do not copy one platform's installed package into another artifact.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
