#!/usr/bin/env node
import { runConnectorCli } from "../../connector-core/src/production.js";
import { createClaudeCodeAdapter } from "./claude-code-adapter.js";

await runConnectorCli(
  "claude",
  async (options) =>
    await createClaudeCodeAdapter({
      ...options,
      connectorPackageVersion: "0.0.0-private",
    }),
);
