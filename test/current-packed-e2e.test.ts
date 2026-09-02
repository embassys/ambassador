import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";

interface ArtifactScanner {
  scanArtifactManifest(value: {
    roots: string[];
    captures: Array<{ name: string; value: string; truncated: boolean }>;
    markers: Array<{ name: string; encoding: "utf8"; value: string }>;
  }): Promise<unknown>;
}

const LOCAL_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "abcdef0123456789abcdef0123456789";
const NOW_SECONDS = 1_788_220_800;

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
  throw new Error("packed Ambassador did not publish its local endpoint");
}

test("clean-installed Ambassador runs the current Node REST fixture", async (t) => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: { prepack?: unknown };
  };
  assert.equal(manifest.scripts?.prepack, "node scripts/clean.mjs dist && pnpm run build");
  const cliPath = process.env.AMBASSADOR_PACKED_CLI;
  if (cliPath === undefined) {
    t.skip("requires the clean-installed package lane");
    return;
  }
  const packed = (await import(pathToFileURL(cliPath).href)) as PackedCli;
  const root = await mkdtemp(join(tmpdir(), "ambassador-current-packed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t, {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = packed.runCli(["start", "--local-token-env=AMBASSADOR_LOCAL_TOKEN"], {
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
    env: {
      AMBASSADOR_LOCAL_TOKEN: LOCAL_TOKEN,
      EMBASSYS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: central.apiUrl,
      stateRoot: root,
      localMcpPort: 0,
      nowSeconds: () => NOW_SECONDS,
    },
  });
  t.after(() => controller.abort());

  const endpoint = await waitForEndpoint(() => stdout);
  const client = new TestMcpClient(endpoint, LOCAL_TOKEN);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    ["register_agent", "verify_email", "resend_verification"],
  );

  const email = "clean-installed@fixture.test";
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhook.url,
      secret_env: "EMBASSYS_WEBHOOK_SECRET",
    },
  });
  const verificationCode = central.verificationCode(email);
  const verified = await client.callTool("verify_email", { email, code: verificationCode });
  assert.equal(verified.verified, true);
  assert.equal(JSON.stringify(verified).includes("token"), false);
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "get_my_permissions",
    ],
  );
  assert.equal(Array.isArray((await client.callTool("list_action_types", {})).action_types), true);

  const marker = "clean-installed-memory-only-message";
  const messageId = central.queueMessage(email, { type: "fixture", value: marker });
  const wake = await webhook.waitForWake();
  assert.equal(wake.rawBody.includes(Buffer.from(marker, "utf8")), true);
  for (
    let attempt = 0;
    attempt < 100 && central.messageState(messageId) !== "acked";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(central.messageState(messageId), "acked");
  assert.equal(
    (await readFile(join(root, "notifications.sqlite"))).includes(Buffer.from(marker, "utf8")),
    false,
  );

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");

  const scanner = (await import(
    pathToFileURL(join(process.cwd(), "scripts", "t02-artifact-scan.mjs")).href
  )) as ArtifactScanner;
  const installedPackageRoot = await realpath(dirname(dirname(cliPath)));
  await scanner.scanArtifactManifest({
    roots: [root, installedPackageRoot],
    captures: [
      { name: "ambassador-stdout", value: stdout, truncated: false },
      { name: "ambassador-stderr", value: stderr, truncated: false },
    ],
    markers: [
      { name: "local-token", encoding: "utf8", value: LOCAL_TOKEN },
      { name: "webhook-secret", encoding: "utf8", value: WEBHOOK_SECRET },
      { name: "registration-email", encoding: "utf8", value: email },
      { name: "verification-code", encoding: "utf8", value: verificationCode },
      { name: "message-body", encoding: "utf8", value: marker },
      { name: "old-package", encoding: "utf8", value: "@a2adev/gateway" },
      { name: "old-binary", encoding: "utf8", value: "a2a-gateway" },
      { name: "old-webhook-flag", encoding: "utf8", value: "--webhook-url" },
      { name: "old-mode-flag", encoding: "utf8", value: "--delivery-mode" },
    ],
  });
});
