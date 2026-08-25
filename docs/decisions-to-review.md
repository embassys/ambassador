# Decisions to review

On August 23, 2026, the user authorized provisional decisions so implementation could continue without waiting at every approval gate. Each decision below is recorded in an ADR and can be changed after review.

ADR `0016-combined-gateway-mcp-proxy.md` is already user-reviewed and accepted. It supersedes provisional ADR `0003-controller-http-transport.md`, ADR 0005's single controller-token shape, and ADR 0009's installation-token assumption. ADR 0003 no longer appears below; the unaffected parts of ADRs 0005 and 0009 remain for review.

| ADR | Decision | Review before |
| --- | --- | --- |
| `0004-journal-shape.md` | Typed delivery and outbox columns with no generic payload storage | Changing persistence or retention |
| `0005-configuration.md` | Strict JSON config with secret references and platform-standard paths | Adding per-binding central JWT and local MCP settings |
| `0006-toolchain.md` | Node 24, npm, TypeScript, node:test, Biome, Zod, and Node core APIs | Changing project tooling or runtime libraries |
| `0007-sqlite.md` | better-sqlite3 with no ORM | Packaging or changing durable storage |
| `0008-runtime-presets.md` | OpenClaw and Hermes native webhooks marked best-effort because dedupe is not durable | Claiming production support for either preset |
| `0009-operating-defaults.md` | HMAC encoding, retry schedule, poll limits, environment credentials, and conservative retention | Implementing combined-process credential handling |
| `0010-user-services.md` | Per-user launchd, systemd, and Task Scheduler lifecycle | Enabling service installation |
| `0011-runtime-cli-flags.md` | Generic, Hermes, and OpenClaw agent-add flags | Adding local MCP proxy flags to the public CLI |
| `0012-http-deadlines.md` | Bounded controller, wake, and health request deadlines | Public beta operating defaults |
| `0013-windows-restart-interval.md` | One-minute Task Scheduler crash restart, superseding ADR 0010's Windows delay | Enabling Windows service installation |
| `0014-lock-handoff-timeout.md` | One-second SQLite singleton-lock handoff window | Public beta operating defaults |

More rows will be added as implementation choices are made.
