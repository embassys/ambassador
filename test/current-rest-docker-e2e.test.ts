import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";

const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXTURE_NOW_SECONDS = 1_788_220_800;

interface PackedCli {
  runCli(
    args: string[],
    context: {
      io: {
        stdout: Pick<NodeJS.WriteStream, "write">;
        stderr: Pick<NodeJS.WriteStream, "write">;
      };
      env: NodeJS.ProcessEnv;
      cwd: string;
      signal: AbortSignal;
      testOverrides: {
        centralOrigin: string;
        stateRoot: string;
        localMcpPort: number;
        nowSeconds: () => number;
      };
    },
  ): Promise<number>;
}

async function waitForEndpoint(read: () => string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = /MCP endpoint: (http:\/\/127\.0\.0\.1:[0-9]+\/mcp)/u.exec(read());
    if (match?.[1] !== undefined) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("packed gateway did not publish its local endpoint");
}

test("I02-X05 packed gateway completes current REST enrollment through the Docker fixture", async (t) => {
  const cliPath = process.env.A2A_PACKED_GATEWAY_CLI;
  const centralOrigin = process.env.A2A_CENTRAL_REST_FIXTURE_URL;
  if (cliPath === undefined || centralOrigin === undefined) {
    t.skip("requires the packed Docker fixture lane");
    return;
  }
  const packed = (await import(pathToFileURL(cliPath).href)) as PackedCli;
  const root = await mkdtemp(join(tmpdir(), "a2a-packed-current-rest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webhook = await startFakeWebhook(t);
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = packed.runCli(
    ["start", `--webhook-url=${webhook.url}`, "--webhook-token-env=PACKED_WEBHOOK_TOKEN"],
    {
      io: {
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            return true;
          },
        },
        stderr: {
          write(chunk: string | Uint8Array) {
            stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            return true;
          },
        },
      },
      env: { PACKED_WEBHOOK_TOKEN: WEBHOOK_TOKEN },
      cwd: root,
      signal: controller.signal,
      testOverrides: {
        centralOrigin,
        stateRoot: root,
        localMcpPort: 0,
        nowSeconds: () => FIXTURE_NOW_SECONDS,
      },
    },
  );
  t.after(() => controller.abort());

  const endpoint = await waitForEndpoint(() => stdout);
  const client = new TestMcpClient(endpoint, WEBHOOK_TOKEN);
  await client.initialize();
  const email = "packed-current@fixture.test";
  await client.callTool("register_agent", { email });
  const codeResponse = await fetch(
    `${centralOrigin}/__test__/verification-code/${encodeURIComponent(email)}`,
    { headers: { "x-a2a-test-control": "central-fixture-control" } },
  );
  assert.equal(codeResponse.status, 200);
  const codeResult = (await codeResponse.json()) as { code: string };
  const verified = await client.callTool("verify_email", { email, code: codeResult.code });
  assert.equal(verified.verified, true);
  assert.equal(JSON.stringify(verified).includes("token"), false);
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "poll_messages",
      "get_my_permissions",
      "ack_message",
    ],
  );
  assert.equal(Array.isArray((await client.callTool("list_action_types", {})).action_types), true);

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");
});
