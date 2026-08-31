import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { loadCl03Production } from "./cl03-production.js";
import { CL02_INPUT_UUID, CL02_SESSION_ID, startRequest } from "./scenarios.js";
import type { ClaudeAdapterProcessBarrier } from "./types.js";

interface OwnerRequest {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly input: string;
  readonly barrier: ClaudeAdapterProcessBarrier;
  readonly monitorModulePath?: string;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let started = false;
lines.on("line", (line) => {
  if (started) process.exit(91);
  started = true;
  void (async () => {
    const request = JSON.parse(line) as OwnerRequest;
    const module = await loadCl03Production("CL02-OWNER");
    const adapter = await module.createClaudeCodeAdapterForTest({
      workingDirectory: request.workingDirectory,
      policy: "read-only",
      inheritedEnvironment: request.environment,
      webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
      connectorPackageVersion: "0.0.0-private",
      fixtureExecutablePath: request.executablePath,
      uuidForTest: (kind) => (kind === "session" ? CL02_SESSION_ID : CL02_INPUT_UUID),
      spawnMonitorForTest(executable, arguments_, options) {
        const monitor = spawn(
          request.monitorModulePath === undefined ? executable : process.execPath,
          request.monitorModulePath === undefined ? [...arguments_] : [request.monitorModulePath],
          {
            cwd: options.cwd,
            env: { ...options.env },
            detached: options.detached,
            shell: options.shell,
            stdio: [...options.stdio],
          },
        );
        send({ channel: "monitor", pid: monitor.pid });
        return monitor;
      },
      async processBarrierForTest(event) {
        if (event.scope !== "turn" || event.barrier !== request.barrier) return;
        send({ channel: "barrier", name: event.barrier });
        await new Promise<never>(() => undefined);
      },
    });
    for await (const event of adapter.start(startRequest(request.input))) {
      send({ channel: "event", value: event });
    }
    await adapter.close();
    send({ channel: "done" });
  })().catch(() => {
    process.stderr.write("CL02 owner worker failed\n");
    process.exit(92);
  });
});
