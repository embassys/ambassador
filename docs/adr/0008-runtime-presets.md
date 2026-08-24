# 0008 Runtime presets

Status: accepted under delegated approval, user review pending

Date: 2026-08-23

## Problem

OpenClaw and Hermes have native webhook ingress, but their duplicate caches are not durable. The sidecar must not claim stronger delivery behavior than the runtimes provide.

## OpenClaw decision

Test against tagged release `v2026.7.1-2` until a newer release is qualified.

- Send `POST /hooks/agent`.
- Authenticate with the configured hook token as a bearer token.
- Send a fixed `message`, fixed `name`, configured `agentId`, `deliver: false`, and `wakeMode: "now"`.
- Send `Idempotency-Key: <delivery_id>`.
- Probe `/healthz` and `/readyz`.
- Treat the preset as best-effort because the five-minute, 1,000-entry duplicate cache is in memory and disappears on restart.
- Do not use `/hooks/wake`; it has no isolated-run or idempotency contract.

The tested release returns success after scheduling the background turn, not after runner entry. Verify a real wake with the fake model request counter.

## Hermes decision

Test against tagged release `v2026.8.19` until a newer release is qualified.

- Send `POST /webhooks/<route>` with body `{"delivery_id":"..."}`.
- Put the fixed claim instruction in the configured route prompt.
- Send `X-Request-ID: <delivery_id>`.
- Authenticate with generic V2 HMAC headers over `<timestamp>.<exact-body-bytes>`.
- Probe `/health` on the webhook listener.
- Require an explicit loopback bind for host installations.
- Treat the preset as best-effort because the one-hour duplicate cache is in memory and disappears on restart.

Hermes returns after scheduling an asynchronous task. Verify a real wake with the fake model request counter.

## Generic adapter

The generic adapter keeps the stronger contract from `docs/protocol-v1.md`. A receiver earns production qualification only when it stores `delivery_id` before starting work and preserves that mapping across restarts for the full retry window.

## Docker tests

Pin official images by release and digest. Persist each runtime's state volume. Bind published ports to host loopback.

Use a local fake OpenAI-compatible model and count its requests. Test duplicate delivery before and after a runtime restart. The current presets should suppress the same-process duplicate and demonstrate the known duplicate after restart.

## Costs

The two presets cannot promise one model session per delivery. Diagnostics and documentation must show `best-effort` until a durable runtime hook or bridge exists.

## Approval

The user delegated this provisional choice on 2026-08-23 and asked to review it later.
