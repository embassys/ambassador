import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { type FakeCentral, startFakeCentral } from "./fake-central.js";
import { startFakeWebhook } from "./fake-webhook.js";
import { type McpTool, TestMcpClient } from "./mcp-client.js";
import { startGateway } from "./start-gateway.js";

export const T04_WEBHOOK_TOKEN = "24a8c1e95f72b466d308ea0c43d8f117b4526a97de31509f";
export const T04_USERNAME = "t04_gateway";
export const T04_EMAIL = "t04-gateway@fixture.invalid";
export const T04_MESSAGE_TEXT = "T04 inbound text must remain in bounded process memory 19f4a2.";
export const T04_REPLY_TEXT = "T04 reply text must never enter gateway durability 6c03b8.";

export interface T04GatewayScenario {
  readonly central: FakeCentral;
  readonly webhook: Awaited<ReturnType<typeof startFakeWebhook>>;
  readonly gateway: Awaited<ReturnType<typeof startGateway>>;
  readonly client: TestMcpClient;
  readonly usedLegacyEnrollment: boolean;
}

export async function startT04GatewayScenario(
  t: TestContext,
  options: {
    readonly artifactRoot?: string;
    readonly beforeVerification?: (central: FakeCentral) => void;
  } = {},
): Promise<T04GatewayScenario> {
  const central = await startFakeCentral(t);
  const gatewayTime = Math.floor(Date.now() / 1_000);
  if (gatewayTime > central.clock()) {
    central.advanceClock(gatewayTime - central.clock());
    central.refreshSeedCredentials();
  }
  const webhook = await startFakeWebhook(t);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T04_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    targetContract: "v2",
    ...(options.artifactRoot === undefined ? {} : { artifactRoot: options.artifactRoot }),
  });
  const client = new TestMcpClient(gateway.endpoint, T04_WEBHOOK_TOKEN);
  await client.initialize();

  await client.callTool("register_agent", {
    username: T04_USERNAME,
    email: T04_EMAIL,
    display_name: "T04 gateway",
  });
  const usedLegacyEnrollment = central.calls.some((call) => call.name === "register_agent");
  options.beforeVerification?.(central);
  await client.callTool("verify_email", {
    email: T04_EMAIL,
    code: usedLegacyEnrollment ? "246810" : "123456",
  });

  return { central, webhook, gateway, client, usedLegacyEnrollment };
}

export async function restartT04Gateway(
  t: TestContext,
  scenario: Pick<T04GatewayScenario, "central" | "webhook" | "gateway">,
): Promise<{
  readonly gateway: Awaited<ReturnType<typeof startGateway>>;
  readonly client: TestMcpClient;
}> {
  const gateway = await startGateway(t, {
    webhookUrl: scenario.webhook.url,
    webhookToken: T04_WEBHOOK_TOKEN,
    centralApiUrl: scenario.central.apiUrl,
    centralMcpUrl: scenario.central.mcpUrl,
    targetContract: "v2",
    artifactRoot: scenario.gateway.artifactRoot,
  });
  const client = new TestMcpClient(gateway.endpoint, T04_WEBHOOK_TOKEN);
  await client.initialize();
  return { gateway, client };
}

function propertyNames(tool: McpTool): string[] {
  const properties = tool.inputSchema.properties;
  assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
  return Object.keys(properties as Record<string, unknown>).sort();
}

export async function requireT04Tool(
  client: TestMcpClient,
  name: string,
  expectedProperties: readonly string[],
  caseId: string,
): Promise<McpTool> {
  const tools = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `[${caseId}] gateway local catalog is missing ${name}`);
  assert.deepEqual(
    propertyNames(tool),
    [...expectedProperties].sort(),
    `[${caseId}] gateway exposes the wrong ${name} input projection`,
  );
  return tool;
}

export async function startInboundConversation(
  scenario: T04GatewayScenario,
  requestId: string,
  text = T04_MESSAGE_TEXT,
): Promise<{ readonly messageId: string; readonly conversationId: string }> {
  scenario.central.setConversationGrant(T04_USERNAME, "fixture_sender", true);
  const sender = scenario.central.seedClient("fixture_sender");
  const response = await sender.request(`${scenario.central.apiUrl}/api/v2/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": requestId,
    },
    body: JSON.stringify({
      recipient_username: T04_USERNAME,
      payload: { text },
    }),
  });
  assert.equal(response.status, 201, "fixture sender could not create the inbound turn");
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof result.message_id, "string");
  assert.equal(typeof result.conversation_id, "string");
  return {
    messageId: result.message_id as string,
    conversationId: result.conversation_id as string,
  };
}

export async function waitForLocalMessage(
  client: TestMcpClient,
  messageId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await client.callTool("poll_messages", { timeout: 0 });
    const messages = result.messages;
    if (Array.isArray(messages)) {
      const message = messages.find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).id === messageId,
      );
      if (message !== undefined) return message as Record<string, unknown>;
    }
    await delay(5);
  }
  throw new Error("gateway did not expose the leased message before the test deadline");
}

interface ArtifactMarker {
  readonly name: string;
  readonly value: string;
}

export async function scanT04Artifacts(options: {
  readonly root: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly markers: readonly ArtifactMarker[];
}): Promise<void> {
  const child = spawn(process.execPath, [`${process.cwd()}/scripts/t02-artifact-scan.mjs`], {
    cwd: process.cwd(),
    env: {
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(
    JSON.stringify({
      roots: [options.root],
      captures: [
        { name: "gateway-stdout", value: options.stdout, truncated: false },
        { name: "gateway-stderr", value: options.stderr, truncated: false },
      ],
      markers: options.markers.map((marker) => ({
        name: marker.name,
        encoding: "utf8",
        value: marker.value,
      })),
    }),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr || "T04 artifact scan failed");
  assert.equal(stderr, "");
  assert.match(stdout, /^artifact scan passed:/u);
}
