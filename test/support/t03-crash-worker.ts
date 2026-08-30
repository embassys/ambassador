import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { arriveAtV2ProcessBarrier } from "./v2-process-barriers.js";

let activeGateway: ChildProcess | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "" || value.includes("\n") || value.includes("\r")) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function waitForGatewayReady(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gateway readiness timed out")), 10_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
      if (!output.includes("MCP endpoint: http://127.0.0.1:8787/mcp")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("gateway exited before readiness"));
    });
  });
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function waitForPublishedCredential(path: string, originalDigest: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(originalDigest)) throw new Error("invalid credential digest");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (current !== originalDigest) return;
    await delay(10);
  }
  throw new Error("credential publication timed out");
}

async function run(): Promise<void> {
  const artifactRoot = requiredEnvironment("T03_ARTIFACT_ROOT");
  const centralApiUrl = requiredEnvironment("T03_CENTRAL_API_URL");
  const centralMcpUrl = requiredEnvironment("T03_CENTRAL_MCP_URL");
  const webhookUrl = requiredEnvironment("T03_WEBHOOK_URL");
  const webhookToken = requiredEnvironment("T03_WEBHOOK_TOKEN");
  const credentialDigest = requiredEnvironment("T03_CREDENTIAL_DIGEST");
  const credentialPath = requiredEnvironment("T03_CREDENTIAL_PATH");
  const expectPublication = process.env.T03_EXPECT_PUBLICATION === "1";

  await arriveAtV2ProcessBarrier("startup", 30_000);
  const gateway = spawn(
    process.execPath,
    [
      join(process.cwd(), ".test-dist", "src", "cli.js"),
      "start",
      `--webhook-url=${webhookUrl}`,
      "--webhook-token-env=A2A_WEBHOOK_TOKEN",
    ],
    {
      cwd: artifactRoot,
      env: {
        HOME: artifactRoot,
        USERPROFILE: artifactRoot,
        XDG_CONFIG_HOME: join(artifactRoot, "config"),
        XDG_STATE_HOME: join(artifactRoot, "state"),
        APPDATA: join(artifactRoot, "appdata"),
        LOCALAPPDATA: join(artifactRoot, "localappdata"),
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
        A2A_WEBHOOK_TOKEN: webhookToken,
        A2A_DEV_CENTRAL_API_URL: centralApiUrl,
        A2A_DEV_CENTRAL_MCP_URL: centralMcpUrl,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  activeGateway = gateway;

  await waitForGatewayReady(gateway);
  await arriveAtV2ProcessBarrier("readiness", 30_000);
  await arriveAtV2ProcessBarrier("operation", 30_000);
  if (expectPublication) {
    await waitForPublishedCredential(credentialPath, credentialDigest);
  }
  await arriveAtV2ProcessBarrier("commit", 30_000);
  await arriveAtV2ProcessBarrier("response", 30_000);
  await arriveAtV2ProcessBarrier("teardown", 30_000);
  await stopGateway(gateway);
  activeGateway = undefined;
  process.stdout.write("T03_PUBLICATION_WORKER_COMPLETE\n");
}

run().catch(async () => {
  if (activeGateway !== undefined) await stopGateway(activeGateway).catch(() => undefined);
  process.stderr.write("T03_PUBLICATION_WORKER_FAILED\n");
  process.exitCode = 1;
});
