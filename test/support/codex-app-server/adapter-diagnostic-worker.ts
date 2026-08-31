import { createInterface } from "node:readline";

import { loadCx03Production } from "./cx03-production.js";
import { createCx02Clock, startRequest, syntheticCx02Environment } from "./scenarios.js";

interface DiagnosticRequest {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly input: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const request = await new Promise<DiagnosticRequest>((resolve, reject) => {
  lines.once("line", (line) => {
    try {
      resolve(JSON.parse(line) as DiagnosticRequest);
    } catch {
      reject(new Error("invalid diagnostic worker request"));
    }
  });
  lines.once("close", () => reject(new Error("missing diagnostic worker request")));
});

try {
  const module = await loadCx03Production("CX02-CX03:X23-worker");
  const adapter = await module.createCodexAppServerAdapterForTest({
    workingDirectory: request.workingDirectory,
    policy: "read-only",
    inheritedEnvironment: syntheticCx02Environment(request.homeDirectory),
    webhookTokenEnvironmentName: "CX02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    clock: createCx02Clock(),
    fixtureExecutablePath: request.executablePath,
  });
  try {
    const events: unknown[] = [];
    for await (const event of adapter.start(startRequest(request.input))) events.push(event);
    const terminal = events.at(-1);
    if (
      terminal === null ||
      typeof terminal !== "object" ||
      Array.isArray(terminal) ||
      (terminal as { event?: unknown }).event !== "uncertain"
    ) {
      throw new Error("diagnostic worker did not observe uncertainty");
    }
  } finally {
    await adapter.close();
  }
  process.stdout.write('{"done":true}\n');
} catch {
  process.stderr.write("CX02 diagnostic worker failed\n");
  process.exitCode = 1;
}
