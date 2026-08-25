import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

interface GatewayProcess {
  endpoint: string;
  artifactRoot: string;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<{ code: number | null; signal: string | null }>;
}

function appendBounded(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length > 65_536 ? combined.slice(-65_536) : combined;
}

function isolatedEnvironment(directory: string, token: string | undefined): NodeJS.ProcessEnv {
  return {
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_STATE_HOME: join(directory, "state"),
    APPDATA: join(directory, "appdata"),
    LOCALAPPDATA: join(directory, "localappdata"),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    ...(token === undefined ? {} : { A2A_WEBHOOK_TOKEN: token }),
  };
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function startGatewayProcess(
  t: TestContext,
  options: { webhookUrl: string; webhookToken: string },
): Promise<GatewayProcess> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-gateway-process-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const executable = join(process.cwd(), ".test-dist", "src", "cli.js");
  const child = spawn(
    process.execPath,
    [
      executable,
      "start",
      `--webhook-url=${options.webhookUrl}`,
      "--webhook-token-env=A2A_WEBHOOK_TOKEN",
    ],
    {
      cwd: directory,
      env: isolatedEnvironment(directory, options.webhookToken),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const exit = waitForExit(child);
  let stopped = false;
  let stopResult: { code: number | null; signal: string | null } | undefined;
  const stop = async (): Promise<{ code: number | null; signal: string | null }> => {
    if (stopped) {
      return stopResult ?? (await exit);
    }
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    stopResult = await exit;
    return stopResult;
  };
  t.after(async () => {
    await stop();
  });

  const endpoint = await Promise.race([
    (async () => {
      while (true) {
        const match = /^MCP endpoint: (http:\/\/127\.0\.0\.1:8787\/mcp)$/mu.exec(stdout);
        if (match?.[1] !== undefined) {
          return match[1];
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("gateway process exited before startup");
        }
        await delay(10);
      }
    })(),
    delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for gateway process startup");
    }),
  ]);

  return {
    endpoint,
    artifactRoot: directory,
    stdout: () => stdout,
    stderr: () => stderr,
    stop,
  };
}

export async function runSecondGateway(
  artifactRoot: string,
  webhookUrl: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = join(process.cwd(), ".test-dist", "src", "cli.js");
  const child = spawn(
    process.execPath,
    [executable, "start", `--webhook-url=${webhookUrl}`, "--webhook-token-env=A2A_WEBHOOK_TOKEN"],
    {
      cwd: artifactRoot,
      env: isolatedEnvironment(artifactRoot, undefined),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const result = await Promise.race([
    waitForExit(child),
    delay(5_000, undefined, { ref: false }).then(() => {
      child.kill("SIGKILL");
      throw new Error("second gateway did not reject singleton contention");
    }),
  ]);
  return { code: result.code, stdout, stderr };
}
