# 0014 Lock handoff timeout

Status: accepted

Date: 2026-08-23

## Problem

After a lock-owning process exits abruptly, the OS can briefly continue reporting the SQLite lock as busy. An immediate process restart can therefore receive a false `daemon_running` result even though no owner remains.

## Decision

Allow the singleton lock's `BEGIN EXCLUSIVE` operation to wait for up to one
second. If the lock remains busy, acquisition fails with `daemon_running`
before Ambassador resolves tokens, opens credentials, binds MCP, polls,
forwards a tool, starts an ACP agent, or sends a webhook.

## Costs

A genuine second daemon can take up to one second to report the ownership conflict. This bounded delay avoids false failures during crash handoff without weakening singleton ownership.

## Approval

The user delegated the provisional choice on 2026-08-23 and approved it after review on 2026-08-26.
