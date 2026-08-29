import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpCallError, TestMcpClient } from "./mcp-client.js";

let activeGateway: ChildProcess | undefined;

import { arriveAtV2ProcessBarrier } from "./v2-process-barriers.js";

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
    const timer = setTimeout(() => reject(new Error("gateway readiness timed out")), 5_000);
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

async function run(): Promise<void> {
  const artifactRoot = requiredEnvironment("T04_ARTIFACT_ROOT");
  const centralApiUrl = requiredEnvironment("T04_CENTRAL_API_URL");
  const centralMcpUrl = requiredEnvironment("T04_CENTRAL_MCP_URL");
  const webhookUrl = requiredEnvironment("T04_WEBHOOK_URL");
  const webhookToken = requiredEnvironment("T04_WEBHOOK_TOKEN");
  const requestId = requiredEnvironment("T04_REQUEST_ID");
  const operationKind = process.env.T04_OPERATION_KIND ?? "start";
  const expectedMessageId = process.env.T04_MESSAGE_ID;
  const expectUncertain = process.env.T04_EXPECT_UNCERTAIN === "1";

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
        ...(process.env.T04_OBSERVER_PRELOAD === undefined
          ? {}
          : {
              NODE_OPTIONS: `--import=${new URL("./t04-response-observer.js", import.meta.url).href}`,
              T04_OBSERVER_PRELOAD: process.env.T04_OBSERVER_PRELOAD,
              T04_OBSERVER_CONTROL_URL: requiredEnvironment("T04_OBSERVER_CONTROL_URL"),
              T04_OBSERVER_TARGET_ORIGIN: requiredEnvironment("T04_OBSERVER_TARGET_ORIGIN"),
              T04_OBSERVER_TARGET_PATH: requiredEnvironment("T04_OBSERVER_TARGET_PATH"),
              T04_OBSERVER_TARGET_METHOD: requiredEnvironment("T04_OBSERVER_TARGET_METHOD"),
            }),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  activeGateway = gateway;

  await waitForGatewayReady(gateway);
  process.stdout.write("T04_GATEWAY_READY\n");
  await arriveAtV2ProcessBarrier("readiness", 30_000);

  const client = new TestMcpClient("http://127.0.0.1:8787/mcp", webhookToken);
  await client.initialize();
  const tools = await client.listTools();
  if (tools.some((tool) => tool.name === "register_agent")) {
    await client.callTool("register_agent", {
      username: "t04_gateway",
      email: "t04-gateway@fixture.invalid",
      display_name: "T04 gateway",
    });
    await client.callTool("verify_email", {
      email: "t04-gateway@fixture.invalid",
      code: "123456",
    });
  }

  await arriveAtV2ProcessBarrier("operation", 30_000);
  let uncertain = false;
  try {
    if (operationKind === "start") {
      await client.callTool("start_conversation", {
        recipient_username: "fixture_recipient",
        payload: { text: "T04 crash text must remain process-only 7e2d91." },
        request_id: requestId,
      });
    } else {
      if (expectedMessageId === undefined) throw new Error("missing T04_MESSAGE_ID");
      if (operationKind === "ack-retry") {
        await client.callTool("ack_message", { message_id: expectedMessageId });
      } else {
        const inbox = await client.callTool("poll_messages", { timeout: 30 });
        const messages = Array.isArray(inbox.messages)
          ? (inbox.messages as Array<Record<string, unknown>>)
          : [];
        if (!messages.some((message) => message.id === expectedMessageId)) {
          throw new Error("expected message was not redelivered");
        }
        if (operationKind === "reply") {
          await client.callTool("reply_message", {
            message_id: expectedMessageId,
            payload: { text: "T04 crash reply must remain process-only 67ac20." },
          });
        } else if (operationKind === "complete") {
          await client.callTool("complete_message", {
            message_id: expectedMessageId,
            outcome: "failed",
            reason_code: "provider_execution_failed",
          });
        } else if (operationKind === "ack") {
          await client.callTool("complete_message", {
            message_id: expectedMessageId,
            outcome: "completed_without_reply",
            reason_code: "no_reply_required",
          });
          await client.callTool("ack_message", { message_id: expectedMessageId });
        } else if (operationKind !== "receive") {
          throw new Error("invalid T04_OPERATION_KIND");
        }
      }
    }
  } catch (error) {
    if (!expectUncertain || !(error instanceof McpCallError)) throw error;
    uncertain = true;
  }
  if (expectUncertain !== uncertain) throw new Error("gateway returned the wrong start outcome");
  await arriveAtV2ProcessBarrier("commit", 30_000);
  process.stdout.write(uncertain ? "T04_OPERATION_UNCERTAIN\n" : "T04_OPERATION_ACCEPTED\n");
  await arriveAtV2ProcessBarrier("response", 30_000);
  await arriveAtV2ProcessBarrier("teardown", 30_000);
  await stopGateway(gateway);
  activeGateway = undefined;
}

run().catch(async () => {
  if (activeGateway !== undefined) await stopGateway(activeGateway).catch(() => undefined);
  process.stderr.write("T04_CRASH_WORKER_FAILED\n");
  process.exitCode = 1;
});
