import { loadCx03Production } from "./cx03-production.js";
import { createCx02Clock, startRequest, syntheticCx02Environment } from "./scenarios.js";

const executablePath = process.argv[2];
const workingDirectory = process.argv[3];
if (executablePath === undefined || workingDirectory === undefined) process.exit(64);

const module = await loadCx03Production("CX02-CX03:X24-worker");
const adapter = await module.createCodexAppServerAdapterForTest({
  workingDirectory,
  policy: "read-only",
  inheritedEnvironment: syntheticCx02Environment("owner-worker"),
  webhookTokenEnvironmentName: "CX02_WEBHOOK_TOKEN",
  connectorPackageVersion: "0.0.0-private",
  clock: createCx02Clock(),
  fixtureExecutablePath: executablePath,
});

let bound = false;
for await (const event of adapter.start(startRequest())) {
  if (
    event !== null &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    (event as { event?: unknown }).event === "turn_bound"
  ) {
    bound = true;
    process.stdout.write('{"ready":true}\n');
  }
}
if (!bound) process.exitCode = 65;
await adapter.close();
