import { createInterface } from "node:readline";

import { loadCl03Production } from "./cl03-production.js";
import { CL02_INPUT_UUID, CL02_SESSION_ID, startRequest } from "./scenarios.js";

interface DiagnosticRequest {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly input: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let started = false;
lines.on("line", (line) => {
  if (started) process.exit(91);
  started = true;
  void (async () => {
    const request = JSON.parse(line) as DiagnosticRequest;
    const module = await loadCl03Production("CL02-DIAGNOSTIC");
    const adapter = await module.createClaudeCodeAdapterForTest({
      workingDirectory: request.workingDirectory,
      policy: "read-only",
      inheritedEnvironment: request.environment,
      webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
      connectorPackageVersion: "0.0.0-private",
      fixtureExecutablePath: request.executablePath,
      uuidForTest: (kind) => (kind === "session" ? CL02_SESSION_ID : CL02_INPUT_UUID),
    });
    try {
      for await (const _event of adapter.start(startRequest(request.input))) {
        // Provider events are deliberately discarded at this diagnostic boundary.
      }
    } finally {
      await adapter.close();
    }
    process.stdout.write('{"done":true}\n');
  })().catch(() => {
    process.stderr.write("CL02 diagnostic worker failed\n");
    process.exitCode = 92;
  });
});
