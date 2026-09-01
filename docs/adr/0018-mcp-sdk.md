# 0018 MCP SDK

Status: accepted; scope clarified by ADR 0037

Date: 2026-08-25

## Problem

The gateway must provide a local Streamable HTTP MCP server with correct
initialization, sessions, JSON-RPC errors, cancellation, and tool-list
behavior.

## Decision

Use the approved official split TypeScript MCP SDK packages at their pinned
versions for the local gateway MCP boundary.

ADR 0037 removes the central MCP client role. The SDK remains required for
local agent interoperability only. Central work uses ordinary bounded REST
clients and adds no MCP transport dependency.

## Packaging impact

The packages are pure JavaScript. Their exact versions and transitive
dependencies remain committed in `pnpm-lock.yaml`, audited, and covered by
packed-install tests.

## Approval

The user approved these dependencies on 2026-08-25 and clarified their local
scope through ADR 0037 on 2026-09-01.
