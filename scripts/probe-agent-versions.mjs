#!/usr/bin/env node

import { arch, platform } from "node:os";

import { AGENT_VERSION_PROBES, observeAgentVersion } from "./agent-version-probes.mjs";

const probes = [];
for (const kind of AGENT_VERSION_PROBES.keys()) {
  probes.push({ kind, ...(await observeAgentVersion(kind)) });
}

process.stdout.write(
  `${JSON.stringify({ schema: 1, platform: platform(), architecture: arch(), probes }, null, 2)}\n`,
);
