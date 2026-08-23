# A2A sidecar

Read this before working on the project.

## What we are building

The sidecar is a small per-user daemon. It wakes local AI agents when the central controller has authorized work for them. The user's machine stays closed to inbound internet traffic, and the sidecar never sees the task itself.

The first release targets resident runtimes such as OpenClaw and Hermes. Users install the daemon once and manage it through a CLI.

## Rules we will not bend

- The sidecar receives opaque IDs. It never receives task text, responses, permissions, or grants.
- The sidecar opens outbound connections to the controller and local runtimes. It does not listen for inbound traffic.
- Once the sidecar acknowledges a notification, that notification must survive a crash or restart.
- A retry uses the same `delivery_id`, so the runtime can detect a duplicate wake.
- One sidecar can route deliveries to several local agents.
- Runtime-specific code stays behind adapters.
- The daemon does not run a model or require model credentials.

## How it fits together

```text
Central controller
  authentication, authorization, delivery queue
          |
          | authenticated long poll, IDs only
          v
Local sidecar daemon
  validation, durable journal, retries, binding lookup
          |
          | authenticated local wake, delivery ID
          v
Wake adapter
  generic webhook, Hermes, or OpenClaw
          |
          v
Local agent runtime
          |
          | claims task and reports results directly
          v
Central MCP endpoint
  owned by another project
```

## Delivery flow

1. The central controller queues an authorized delivery for a registered local binding.
2. The sidecar receives an opaque notification through long polling.
3. The sidecar validates and records the notification before acknowledging it.
4. The sidecar resolves the binding and wakes the local runtime with a fixed instruction and `delivery_id`.
5. The runtime starts or resumes one isolated session for that delivery.
6. The agent claims and processes the task directly through the central MCP endpoint.
7. The sidecar reports only wake acceptance or failure to the controller.

## Data boundary

The sidecar may store notification, delivery, and binding IDs. It may also store retry state, timestamps, local session mappings, and pending acknowledgements or wake reports.

It must not store prompts, attachments, agent responses, results, permission details, grants, or MCP request and response bodies.

## Who owns what

| Component | Responsibility |
| --- | --- |
| Central controller | Authentication policy, authorization, delivery assignment, task state, and grants |
| Sidecar | Notification receipt, local binding lookup, wake retries, service lifecycle, and diagnostics |
| Wake adapter | Runtime authentication, request translation, health checks, and idempotency keys |
| Local runtime | Agent sessions and direct calls to the central MCP endpoint |

## First release

- Headless daemon plus CLI.
- macOS, Linux, and Windows service support.
- Generic authenticated webhook adapter.
- Hermes and OpenClaw presets after their wake paths and duplicate handling pass our tests.
- Model-free fake controller and fake runtime for local and CI testing.

## Not in the first release

- Remote MCP implementation.
- Task, result, or permission handling.
- Public A2A server or Agent Card.
- ACP and headless CLI adapters.
- Grok Bot and hosted-agent connectors.
- Desktop GUI and automatic self-update.

## Two open constraints

The sidecar needs a durable local journal, but we have not chosen its implementation. SQLite is one option. We will not choose a library without the user's approval.

Duplicate handling also needs proof in each runtime. If an HTTP request reaches the runtime but its response is lost, the sidecar has to retry. That retry can start a second model turn unless the runtime stores `delivery_id` or resumes the same session.
