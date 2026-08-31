#!/usr/bin/env node
import { runConnectorCli } from "../../connector-core/src/production.js";
import { createCodexAppServerAdapter } from "./app-server-adapter.js";

await runConnectorCli(
  "codex",
  async (options) =>
    await createCodexAppServerAdapter({
      ...options,
      connectorPackageVersion: "0.0.0-private",
    }),
);
