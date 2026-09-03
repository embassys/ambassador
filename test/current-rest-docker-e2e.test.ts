import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";

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

async function createWebhookSecret(packed: PackedCli, root: string, centralOrigin: string) {
  let stdout = "";
  let stderr = "";
  const result = await packed.runCli(["webhook-secret"], {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    env: {},
    cwd: root,
    signal: new AbortController().signal,
    testOverrides: {
      centralOrigin,
      stateRoot: root,
      localMcpPort: 0,
      nowSeconds: () => FIXTURE_NOW_SECONDS,
    },
  });
  assert.equal(result, 0);
  assert.equal(stderr, "");
  const secret = stdout.trim();
  assert.match(secret, /^[a-f0-9]{48}$/u);
  return secret;
}

async function waitForEndpoint(read: () => string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = /MCP endpoint: (http:\/\/127\.0\.0\.1:[0-9]+\/mcp)/u.exec(read());
    if (match?.[1] !== undefined) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("packed Ambassador did not publish its local endpoint");
}

test("packed Ambassador completes REST enrollment through the Docker fixture", async (t) => {
  const cliPath = process.env.AMBASSADOR_PACKED_CLI;
  const centralOrigin = process.env.AMBASSADOR_CENTRAL_REST_FIXTURE_URL;
  if (cliPath === undefined || centralOrigin === undefined) {
    t.skip("requires the packed Docker fixture lane");
    return;
  }
  const packed = (await import(pathToFileURL(cliPath).href)) as PackedCli;
  const root = await mkdtemp(join(tmpdir(), "ambassador-packed-current-rest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webhookSecret = await createWebhookSecret(packed, root, centralOrigin);
  const webhook = await startFakeWebhook(t, {
    secret: webhookSecret,
    nowSeconds: FIXTURE_NOW_SECONDS,
  });
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = packed.runCli(["start"], {
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
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin,
      stateRoot: root,
      localMcpPort: 0,
      nowSeconds: () => FIXTURE_NOW_SECONDS,
    },
  });
  t.after(() => controller.abort());

  const endpoint = await waitForEndpoint(() => stdout);
  const client = new TestMcpClient(endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  const email = "packed-current@fixture.test";
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhook.url,
    },
  });
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
      "submit_action_result",
      "get_my_permissions",
    ],
  );
  assert.equal(Array.isArray((await client.callTool("list_action_types", {})).action_types), true);

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");
});
