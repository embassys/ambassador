# 0018 MCP SDK

Status: proposed

Date: 2026-08-25

## Problem

The gateway must act as both a Streamable HTTP MCP server and an MCP client. The protocol includes initialization, version negotiation, sessions, JSON-RPC errors, JSON and SSE responses, cancellation, and tool-list behavior. A partial project-owned implementation would be small at first but easy to get wrong.

## Options

- Use the official TypeScript SDK packages at version `2.0.0`: `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and the Node transport package. They are MIT licensed, require Node 20 or newer, and are maintained in the official Model Context Protocol repository. The Node transport also requires Hono.
- Use the combined `@modelcontextprotocol/sdk` package at version `1.30.0`. It is MIT licensed and widely used, but brings 17 direct runtime dependencies and represents the older package layout.
- Implement the required Streamable HTTP subset with Node core. This avoids dependencies but makes this project responsible for protocol negotiation, SSE, sessions, cancellation, and future compatibility.

## Recommendation

Use the official split version 2 packages after a compatibility test proves they interoperate with FastMCP `3.4.7` and OpenClaw `2026.7.1-2`. Do not install them before user approval.

## Packaging impact

The packages are pure JavaScript and do not add another runtime or executable. Exact versions and transitive dependencies must be committed in `package-lock.json`, audited, and included in packed-install tests.

## Approval needed

The user has approved MCP proxy behavior but has not yet approved these production dependencies.
