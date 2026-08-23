# Decisions to review

On August 23, 2026, the user authorized provisional decisions so implementation could continue without waiting at every approval gate. Each decision below is recorded in an ADR and can be changed after review.

| ADR | Decision | Review before |
| --- | --- | --- |
| `0001-cli-interface.md` | Grouped `a2a` commands, JSON output contract, and stable exit codes | Public CLI release |
| `0002-distribution.md` | Node package for development, signed standalone files for users, containers for tests | Publishing any package |
| `0003-controller-http-transport.md` | Fixed REST paths and bearer installation token for the development contract | Connecting to the central controller |
| `0004-journal-shape.md` | Typed delivery and outbox columns with no generic payload storage | Changing persistence or retention |
| `0005-configuration.md` | Strict JSON config with secret references and platform-standard paths | Locking the CLI setup flow |
| `0006-toolchain.md` | Node 24, npm, TypeScript, node:test, Biome, Zod, and Node core APIs | Changing project tooling or runtime libraries |
| `0007-sqlite.md` | better-sqlite3 with no ORM | Packaging or changing durable storage |
| `0008-runtime-presets.md` | OpenClaw and Hermes native webhooks marked best-effort because dedupe is not durable | Claiming production support for either preset |
| `0009-operating-defaults.md` | HMAC encoding, retry schedule, poll limits, environment credentials, and conservative retention | Public beta operating defaults |
| `0010-user-services.md` | Per-user launchd, systemd, and Task Scheduler lifecycle | Enabling service installation |

More rows will be added as implementation choices are made.
