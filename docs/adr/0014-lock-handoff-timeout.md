# 0014 Lock handoff timeout

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

After a lock-owning process exits abruptly, the OS can briefly continue reporting the SQLite lock as busy. An immediate process restart can therefore receive a false `daemon_running` result even though no owner remains.

## Decision

Allow the singleton lock's `BEGIN EXCLUSIVE` operation to wait for up to one second. If the lock remains busy, acquisition fails with `daemon_running` before the process resolves tokens, opens credentials, binds MCP, polls, forwards a tool, or sends a webhook.

## Costs

A genuine second daemon can take up to one second to report the ownership conflict. This bounded delay avoids false failures during crash handoff without weakening singleton ownership.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
