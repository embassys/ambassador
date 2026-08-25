import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { startFakeCentral } from "./support/fake-central.js";
import { startGatewayProcess } from "./support/gateway-process.js";
import { TestMcpClient } from "./support/mcp-client.js";

const OPENCLAW_CLI = process.env.A2A_OPENCLAW_CLI;
const GATEWAY_CLI = process.env.A2A_PACKED_GATEWAY_CLI;
const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const EMAIL = "openclaw-agent@example.test";
const CODE = "246810";
const execFileAsync = promisify(execFile);

function appendBounded(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length > 65_536 ? combined.slice(-65_536) : combined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail("condition was not reached");
}

async function startOpenClaw(
  t: TestContext,
  executable: string,
): Promise<{
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
  stdout: () => string;
  stderr: () => string;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "a2a-openclaw-test-"));
  await chmod(stateRoot, 0o700);
  await writeFile(join(stateRoot, ".env"), `A2A_HOOK_TOKEN=${WEBHOOK_TOKEN}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(stateRoot, "openclaw.json"),
    `${JSON.stringify(
      {
        hooks: {
          enabled: true,
          path: "/hooks",
          token: `\${A2A_HOOK_TOKEN}`,
        },
        mcp: {
          servers: {
            a2a: {
              url: "http://127.0.0.1:8787/mcp",
              transport: "streamable-http",
              headers: { Authorization: `Bearer \${A2A_HOOK_TOKEN}` },
              connectionTimeoutMs: 5_000,
              requestTimeoutMs: 35_000,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = {
    HOME: stateRoot,
    USERPROFILE: stateRoot,
    OPENCLAW_STATE_DIR: stateRoot,
    A2A_HOOK_TOKEN: WEBHOOK_TOKEN,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  };
  const child = spawn(
    process.execPath,
    [executable, "gateway", "run", "--allow-unconfigured", "--auth", "none", "--port", "18789"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      exit,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 10_000);
        timeout.unref();
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (outcome === undefined) {
      child.kill("SIGKILL");
      await exit;
      assert.fail("OpenClaw did not stop after SIGTERM");
    }
  };
  t.after(async () => {
    await stop();
    await rm(stateRoot, { force: true, recursive: true });
  });

  let ready = false;
  const readinessDeadline = Date.now() + 30_000;
  while (Date.now() < readinessDeadline) {
    const outcome = await Promise.race([
      fetch("http://127.0.0.1:18789/", { signal: AbortSignal.timeout(500) })
        .then(() => "ready" as const)
        .catch(() => "waiting" as const),
      exit.then(() => "exited" as const),
    ]);
    if (outcome === "ready") {
      ready = true;
      break;
    }
    if (outcome === "exited") break;
    await delay(100);
  }
  assert.ok(ready, `OpenClaw did not start\n${stdout}\n${stderr}`);
  return { env, stop, stdout: () => stdout, stderr: () => stderr };
}

async function probeOpenClaw(executable: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [executable, "mcp", "probe", "a2a", "--json"],
    {
      env,
      maxBuffer: 1_048_576,
    },
  );
  const result = JSON.parse(stdout) as { tools?: unknown };
  assert.ok(Array.isArray(result.tools));
  return result.tools.map(String).sort();
}

test("the packaged gateway interoperates with OpenClaw 2026.7.1-2", {
  skip: OPENCLAW_CLI === undefined || GATEWAY_CLI === undefined,
  timeout: 60_000,
}, async (t) => {
  assert.ok(OPENCLAW_CLI !== undefined);
  assert.ok(GATEWAY_CLI !== undefined);
  const openclaw = await startOpenClaw(t, OPENCLAW_CLI);
  const webhookResponse = await fetch("http://127.0.0.1:18789/hooks/agent", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WEBHOOK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "You have new A2A work. Use the A2A tools to poll, process, and acknowledge it.",
    }),
  });
  assert.equal(webhookResponse.status, 200);

  const central = await startFakeCentral(t);
  const gateway = await startGatewayProcess(t, {
    webhookUrl: "http://127.0.0.1:18789/hooks/agent",
    webhookToken: WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    executable: GATEWAY_CLI,
  });
  assert.deepEqual(await probeOpenClaw(OPENCLAW_CLI, openclaw.env), [
    "a2a__register_agent",
    "a2a__resend_verification",
    "a2a__verify_email",
  ]);

  const client = new TestMcpClient(gateway.endpoint, WEBHOOK_TOKEN, {
    forbiddenResponseValues: [central.jwt],
  });
  await client.initialize();
  await client.callTool("register_agent", {
    username: "openclaw-agent",
    email: EMAIL,
    display_name: "OpenClaw Agent",
  });
  const listChanged = client.waitForNotification("notifications/tools/list_changed");
  const verification = await client.callTool("verify_email", { email: EMAIL, code: CODE });
  assert.equal(verification.verified, true);
  await listChanged;
  assert.deepEqual(await probeOpenClaw(OPENCLAW_CLI, openclaw.env), [
    "a2a__ack_message",
    "a2a__poll_messages",
  ]);

  central.injectMessage("openclaw_message_01", "OpenClaw interoperability content");
  await waitFor(() => central.messageState("openclaw_message_01").notificationAcknowledged);
  const polled = await client.callTool("poll_messages", { timeout: 0 });
  assert.equal((polled.messages as Array<{ id: string }>)[0]?.id, "openclaw_message_01");
  await client.callTool("ack_message", { message_id: "openclaw_message_01" });

  const stopped = await gateway.stop();
  assert.equal(stopped.code, 0);
  await openclaw.stop();
  assert.ok(!openclaw.stdout().includes(WEBHOOK_TOKEN));
  assert.ok(!openclaw.stderr().includes(WEBHOOK_TOKEN));
});
