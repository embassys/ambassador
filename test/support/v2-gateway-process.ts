#!/usr/bin/env node

import { join } from "node:path";

import { runCli } from "../../src/cli.js";

const centralApiUrl = process.env.A2A_DEV_CENTRAL_API_URL;
const centralMcpUrl = process.env.A2A_DEV_CENTRAL_MCP_URL;
const stateParent = process.env.XDG_STATE_HOME;

if (centralApiUrl === undefined || centralMcpUrl === undefined || stateParent === undefined) {
  throw new Error("The version 2 process fixture is not configured");
}

process.exitCode = await runCli(process.argv.slice(2), {
  io: { stdout: process.stdout, stderr: process.stderr },
  env: process.env,
  cwd: process.cwd(),
  testOverrides: {
    centralApiUrl,
    centralMcpUrl,
    stateRoot: join(stateParent, "a2a-gateway"),
    centralEnrollmentProfile: {
      issuer: "urn:a2a:fixture:issuer:v2",
      audiences: ["urn:a2a:fixture:resource:api:v2", "urn:a2a:fixture:resource:mcp:v2"],
    },
  },
});
