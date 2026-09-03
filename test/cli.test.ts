import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { TestMcpClient } from "./support/mcp-client.js";

test("creates and prints one stable webhook secret without taking the gateway lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-secret-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [];
  const io = {
    stdout: {
      write(chunk: string | Uint8Array) {
        output.push(String(chunk));
        return true;
      },
    },
    stderr: { write: () => true },
  };
  const context = {
    io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };

  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(output.length, 2);
  assert.match(output[0] ?? "", /^[a-f0-9]{48}\n$/u);
  assert.equal(output[1], output[0]);
});

test("starts and serves MCP with no options or environment variables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-zero-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  let stdout = "";
  let stderr = "";
  const running = runCli(["start"], {
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
    signal: controller.signal,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localMcpPort: 0,
    },
  });

  let endpoint: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(stdout)?.[1];
    if (endpoint !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(endpoint !== undefined);
  const client = new TestMcpClient(endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    ["register_agent", "verify_email", "resend_verification"],
  );

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");
});
