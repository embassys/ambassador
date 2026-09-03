import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { ProcessLock } from "../src/process-lock.js";
import { TestMcpClient } from "./support/mcp-client.js";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

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

test("cleans all local registration and delivery residue and leaves provider files alone", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-cli-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "state", "ambassador");
  await mkdir(join(root, "stale-directory"), { recursive: true });
  for (const name of [
    "central-credential.json",
    "central-credential.key",
    "webhook-secret.json",
    "webhook-secret.key",
    "delivery-profile.json",
    "notifications.sqlite",
    "interrupted-write.tmp",
  ]) {
    await writeFile(join(root, name), `residue:${name}`);
  }
  await writeFile(join(root, "stale-directory", "artifact"), "nested residue");
  const providerFile = join(parent, "provider-config.json");
  await writeFile(providerFile, "provider state");
  if (process.platform !== "win32") {
    await symlink(providerFile, join(root, "provider-link"));
  }

  const output = captureIo();
  const context = {
    io: output.io,
    env: {},
    cwd: parent,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };
  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(await readFile(providerFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "Ambassador local state cleared\n");
  assert.equal(output.stderr(), "");

  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(output.stdout(), "Ambassador local state cleared\nAmbassador local state cleared\n");
});

test("clean refuses to touch state while Ambassador owns the process lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-clean-running-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const residuePath = join(root, "delivery-profile.json");
  await writeFile(residuePath, "keep while running");
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  t.after(() => lock.release());
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: root,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  await access(residuePath);
  assert.equal(await readFile(residuePath, "utf8"), "keep while running");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "Ambassador is already running\n");
});

test("clean rejects a linked state directory without touching its target", {
  skip: process.platform === "win32",
}, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-linked-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "provider-state");
  const root = join(parent, "ambassador-state");
  const targetFile = join(target, "provider-config.json");
  await mkdir(target);
  await writeFile(targetFile, "provider state");
  await symlink(target, root);
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: parent,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  assert.equal(await readFile(targetFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "The Ambassador lock artifact is invalid\n");
});
