# 0018 MCP SDK

Status: accepted

Date: 2026-08-25

## Problem

The gateway must act as both a Streamable HTTP MCP server and an MCP client. The protocol includes initialization, version negotiation, sessions, JSON-RPC errors, JSON and SSE responses, cancellation, and tool-list behavior. A partial project-owned implementation would be small at first but easy to get wrong.

## Options

- Use the official TypeScript SDK packages `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/node` at version `2.0.0`. They are MIT licensed, require Node 20 or newer, and are maintained in the official Model Context Protocol repository. The server and client use `@modelcontextprotocol/core` and Zod; the Node transport requires `@hono/node-server`.
- Use the combined `@modelcontextprotocol/sdk` package at version `1.30.0`. It is MIT licensed and widely used, but brings 17 direct runtime dependencies and represents the older package layout.
- Implement the required Streamable HTTP subset with Node core. This avoids dependencies but makes this project responsible for protocol negotiation, SSE, sessions, cancellation, and future compatibility.

## Decision

Use the official split version 2 packages. Compatibility tests must prove interoperability with FastMCP `3.4.7` and OpenClaw `2026.7.1-2`; a compatibility failure returns this decision for review rather than triggering a project-owned protocol implementation.

## Packaging impact

The packages are pure JavaScript and do not add another runtime or executable. Exact versions and transitive dependencies must be committed in `pnpm-lock.yaml`, audited, and included in packed-install tests.

## Approval

The user approved these exact production dependencies on 2026-08-25.
