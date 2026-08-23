# 0011 Runtime CLI flags

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

`a2a agent add` needs noninteractive flags for all three v1 adapters. Native runtimes use different credential names and OpenClaw also needs an agent ID.

## Decision

Use these forms:

```text
a2a agent add <binding-id> --adapter generic --url <url> --secret-env <name>
a2a agent add <binding-id> --adapter hermes --url <url> --secret-env <name>
a2a agent add <binding-id> --adapter openclaw --url <url> --agent-id <id> --token-env <name>
```

Each form accepts `--health-url`. The command stores only the environment-variable name. Literal `--secret` and `--token` values remain forbidden.

`a2a agent test <binding-id>` constructs the selected adapter and runs its unauthenticated health probe. It resolves the credential first so the test also catches a missing service environment variable, but it never sends that credential to a health endpoint.

## Costs

Environment-variable names differ between generic or Hermes and OpenClaw. This mirrors the runtime concepts and avoids calling a bearer token a webhook secret.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
