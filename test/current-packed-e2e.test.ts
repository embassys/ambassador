import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
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

const NOW_SECONDS = 1_788_220_800;

function legacyEndpointName(kind: "API" | "MCP"): string {
  return ["A2A", "DEV", "CENTRAL", kind, "URL"].join("_");
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
      nowSeconds: () => NOW_SECONDS,
    },
  });
  assert.equal(result, 0);
  assert.equal(stderr, "");
  const secret = stdout.trim();
  assert.match(secret, /^[a-f0-9]{48}$/u);
  return secret;
}

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
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 5_000);
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
  const installedDist = dirname(cliPath);
  const directDelivery = (await import(
    pathToFileURL(join(installedDist, "direct-delivery.js")).href
  )) as {
    resolveBundledNodePackageEntrypoint(contract: {
      packageName: string;
      binName: string;
      entrypoint: string;
    }): Promise<string>;
  };
  const capabilities = (await import(
    pathToFileURL(join(installedDist, "agent-capabilities.js")).href
  )) as {
    PRODUCTION_AGENT_CAPABILITIES: Array<{
      kind: string;
      direct?: {
        bundledNodePackage?: {
          packageName: string;
          binName: string;
          entrypoint: string;
        };
      };
    }>;
  };
  const codexContract = capabilities.PRODUCTION_AGENT_CAPABILITIES.find(
    (item) => item.kind === "codex",
  )?.direct?.bundledNodePackage;
  assert.ok(codexContract !== undefined);
  assert.match(
    await directDelivery.resolveBundledNodePackageEntrypoint(codexContract),
    /[/\\]dist[/\\]index\.js$/u,
  );
  const claudeContract = capabilities.PRODUCTION_AGENT_CAPABILITIES.find(
    (item) => item.kind === "claude",
  )?.direct?.bundledNodePackage;
  assert.ok(claudeContract !== undefined);
  assert.match(
    await directDelivery.resolveBundledNodePackageEntrypoint(claudeContract),
    /[/\\]dist[/\\]index\.js$/u,
  );
  const root = await mkdtemp(join(tmpdir(), "ambassador-current-packed-"));
  const controller = new AbortController();
  const restartController = new AbortController();
  const gatewayRuns: Array<Promise<number>> = [];
  // Stop listeners before removing their state, including on a failed assertion.
  t.after(async () => {
    controller.abort();
    restartController.abort();
    await Promise.all(gatewayRuns);
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const webhookSecret = await createWebhookSecret(packed, root, central.apiUrl);
  const webhook = await startFakeWebhook(t, {
    secret: webhookSecret,
    nowSeconds: NOW_SECONDS,
    contract: "openclaw-agent",
  });
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
      centralOrigin: central.apiUrl,
      stateRoot: root,
      localMcpPort: 0,
      nowSeconds: () => NOW_SECONDS,
    },
  });
  gatewayRuns.push(running);

  const endpoint = await waitForEndpoint(() => stdout);
  const client = new TestMcpClient(endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  const stableToolCatalog = [
    "register_agent",
    "verify_email",
    "resend_verification",
    "list_action_types",
    "request_permission",
    "get_inbox",
    "call_action",
    "submit_action_result",
    "get_my_permissions",
  ];
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    stableToolCatalog,
  );

  const email = "clean-installed@fixture.test";
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhook.url,
    },
  });
  const verificationCode = central.verificationCode(email);
  const verified = await client.callTool("verify_email", { email, code: verificationCode });
  assert.equal(verified.verified, true);
  assert.equal(JSON.stringify(verified).includes("token"), false);
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    stableToolCatalog,
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
      { name: "webhook-secret", encoding: "utf8", value: webhookSecret },
      { name: "registration-email", encoding: "utf8", value: email },
      { name: "verification-code", encoding: "utf8", value: verificationCode },
      { name: "message-body", encoding: "utf8", value: marker },
      { name: "old-package", encoding: "utf8", value: "@a2adev/gateway" },
      { name: "old-binary", encoding: "utf8", value: "a2a-gateway" },
      { name: "old-webhook-flag", encoding: "utf8", value: "--webhook-url" },
      { name: "old-mode-flag", encoding: "utf8", value: "--delivery-mode" },
      { name: "old-development-api", encoding: "utf8", value: legacyEndpointName("API") },
      { name: "old-development-mcp", encoding: "utf8", value: legacyEndpointName("MCP") },
    ],
  });

  let cleanStdout = "";
  let cleanStderr = "";
  assert.equal(
    await packed.runCli(["clean"], {
      io: {
        stdout: {
          write(chunk) {
            cleanStdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write(chunk) {
            cleanStderr += String(chunk);
            return true;
          },
        },
      },
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: central.apiUrl,
        stateRoot: root,
        localMcpPort: 0,
        nowSeconds: () => NOW_SECONDS,
      },
    }),
    0,
  );
  assert.equal(cleanStdout, "Ambassador local state cleared\n");
  assert.equal(cleanStderr, "");
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);

  let restartStdout = "";
  let restartStderr = "";
  const restarted = packed.runCli(["start"], {
    io: {
      stdout: {
        write(chunk) {
          restartStdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk) {
          restartStderr += String(chunk);
          return true;
        },
      },
    },
    env: {},
    cwd: root,
    signal: restartController.signal,
    testOverrides: {
      centralOrigin: central.apiUrl,
      stateRoot: root,
      localMcpPort: 0,
      nowSeconds: () => NOW_SECONDS,
    },
  });
  gatewayRuns.push(restarted);
  const restartEndpoint = await waitForEndpoint(() => restartStdout);
  const restartClient = new TestMcpClient(restartEndpoint);
  await restartClient.initialize({ name: "openclaw-bundle-mcp", version: "clean-check" });
  assert.deepEqual(
    (await restartClient.listTools()).map(({ name }) => name),
    stableToolCatalog,
  );
  restartController.abort();
  assert.equal(await restarted, 0);
  assert.equal(restartStderr, "");
});
