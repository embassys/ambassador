import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { syntheticCl02Environment } from "./scenarios.js";
import type { ClaudeAdapterProcessBarrier } from "./types.js";

export interface ClaudeOwnerHarness {
  readonly worker: ChildProcess;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  waitForMonitorCount(count: number): Promise<void>;
  waitForBarrier(name: ClaudeAdapterProcessBarrier): Promise<void>;
}

export async function startClaudeOwnerHarness(request: {
  readonly executablePath: string;
  readonly input: string;
  readonly barrier: ClaudeAdapterProcessBarrier;
  readonly monitorModulePath?: string;
}): Promise<ClaudeOwnerHarness> {
  const workerPath = fileURLToPath(new URL("./adapter-owner-worker.js", import.meta.url));
  const worker = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: syntheticCl02Environment("owner-worker"),
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(worker.stdin !== null && worker.stdout !== null && worker.stderr !== null);
  const messages: Readonly<Record<string, unknown>>[] = [];
  createInterface({ input: worker.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
    "line",
    (line) => messages.push(JSON.parse(line) as Readonly<Record<string, unknown>>),
  );
  let stderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  worker.stdin.end(
    `${JSON.stringify({
      executablePath: request.executablePath,
      workingDirectory: process.cwd(),
      environment: syntheticCl02Environment("owner-provider"),
      input: request.input,
      barrier: request.barrier,
      ...(request.monitorModulePath === undefined
        ? {}
        : { monitorModulePath: request.monitorModulePath }),
    })}\n`,
  );

  const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(
          `CL02 owner exited before ${description}: ${worker.exitCode}/${worker.signalCode}/${stderr}`,
        );
      }
      if (Date.now() >= deadline) throw new Error(`CL02 owner did not reach ${description}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  return {
    worker,
    messages,
    async waitForMonitorCount(count) {
      await waitFor(
        () => messages.filter((entry) => entry.channel === "monitor").length >= count,
        `${count} monitor launches`,
      );
    },
    async waitForBarrier(name) {
      await waitFor(
        () => messages.some((entry) => entry.channel === "barrier" && entry.name === name),
        name,
      );
    },
  };
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function waitForClaudeProcessGroupEmpty(pgid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (processGroupExists(pgid)) {
    if (Date.now() >= deadline) throw new Error("CL02 monitor group survived owner death");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export async function stopClaudeOwnerHarness(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  worker.kill("SIGKILL");
  await new Promise<void>((resolve) => worker.once("close", () => resolve()));
}
