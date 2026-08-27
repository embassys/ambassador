import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runCli } from "../src/cli.js";

function writer(): { stream: Pick<NodeJS.WriteStream, "write">; read: () => string } {
  let value = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    read: () => value,
  };
}

async function directory(t: TestContext): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "a2a-cli-contract-test-"));
  t.after(() => rm(value, { force: true, recursive: true }));
  return value;
}

async function invoke(
  args: string[],
  root: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = writer();
  const stderr = writer();
  const exitCode = await runCli(args, {
    cwd: root,
    env: {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "localappdata"),
      ...env,
    },
    io: { stdout: stdout.stream, stderr: stderr.stream },
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
}

test("removed setup is rejected without exposing its obsolete secret", async (t) => {
  const root = await directory(t);
  const secret = "obsolete-controller-secret-must-not-appear";
  const result = await invoke(
    [
      "setup",
      "--controller-url",
      "https://controller.invalid",
      "--controller-token-env",
      "A2A_CONTROLLER_TOKEN",
      "--config",
      join(root, "config.json"),
    ],
    root,
    { A2A_CONTROLLER_TOKEN: secret },
  );

  assert.equal(result.exitCode, 2);
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stderr.includes(secret));
});

test("removed agent management is rejected even when a legacy config exists", async (t) => {
  const root = await directory(t);
  const configPath = join(root, "legacy.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      controller: {
        base_url: "https://controller.invalid",
        token: { source: "env", name: "OLD_TOKEN" },
        poll_wait_seconds: 30,
        max_notifications: 50,
        queue_capacity: 1000,
      },
      agents: [],
    }),
  );

  const result = await invoke(["agent", "list", "--config", configPath], root);
  assert.equal(result.exitCode, 2);
});

test("invalid startup forms are rejected without reflecting secret-like values", async (t) => {
  const validUrl = "http://127.0.0.1:18789/hooks/agent";
  const cases: Array<{
    name: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    exitCode?: number;
  }> = [
    { name: "missing URL", args: ["start", "--webhook-token-env=A2A_WEBHOOK_TOKEN"] },
    { name: "missing token reference", args: ["start", `--webhook-url=${validUrl}`] },
    {
      name: "split options",
      args: ["start", "--webhook-url", validUrl, "--webhook-token-env", "A2A_WEBHOOK_TOKEN"],
    },
    {
      name: "duplicate option",
      args: [
        "start",
        `--webhook-url=${validUrl}`,
        `--webhook-url=${validUrl}`,
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "unknown option",
      args: [
        "start",
        `--webhook-url=${validUrl}`,
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
        "--unknown=secret-like-value",
      ],
    },
    {
      name: "positional",
      args: [
        "start",
        `--webhook-url=${validUrl}`,
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
        "binding-id",
      ],
    },
    {
      name: "literal token",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token=literal-secret-value"],
    },
    {
      name: "remote HTTPS URL",
      args: [
        "start",
        "--webhook-url=https://hooks.example/agent",
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "localhost hostname",
      args: [
        "start",
        "--webhook-url=http://localhost:18789/hooks/agent",
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "missing port",
      args: [
        "start",
        "--webhook-url=http://127.0.0.1/hooks/agent",
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "URL credentials",
      args: [
        "start",
        "--webhook-url=http://user:password@127.0.0.1:18789/hooks/agent",
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "URL fragment",
      args: [
        "start",
        "--webhook-url=http://127.0.0.1:18789/hooks/agent#fragment",
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ],
    },
    {
      name: "invalid environment name",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token-env=bad-name"],
    },
    {
      name: "missing environment value",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token-env=A2A_WEBHOOK_TOKEN"],
      exitCode: 4,
    },
    {
      name: "empty environment value",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token-env=A2A_WEBHOOK_TOKEN"],
      env: { A2A_WEBHOOK_TOKEN: "" },
      exitCode: 4,
    },
    {
      name: "non-generated token value",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token-env=A2A_WEBHOOK_TOKEN"],
      env: { A2A_WEBHOOK_TOKEN: "not-an-openclaw-generated-token" },
      exitCode: 4,
    },
    {
      name: "line break in environment value",
      args: ["start", `--webhook-url=${validUrl}`, "--webhook-token-env=A2A_WEBHOOK_TOKEN"],
      env: { A2A_WEBHOOK_TOKEN: "secret-like-value\nsecond-line" },
      exitCode: 4,
    },
    {
      name: "verbose without development endpoints",
      args: [
        "start",
        `--webhook-url=${validUrl}`,
        "--webhook-token-env=A2A_WEBHOOK_TOKEN",
        "--verbose=true",
      ],
      env: { A2A_WEBHOOK_TOKEN: "0123456789abcdef0123456789abcdef0123456789abcdef" },
      exitCode: 2,
    },
  ];

  for (const item of cases) {
    const root = await directory(t);
    const result = await invoke(item.args, root, item.env);
    assert.equal(result.exitCode, item.exitCode ?? 2, item.name);
    for (const marker of [
      "literal-secret-value",
      "secret-like-value",
      "not-an-openclaw-generated-token",
      "second-line",
      "password",
    ]) {
      assert.ok(!result.stdout.includes(marker), `${item.name} reflected a marker to stdout`);
      assert.ok(!result.stderr.includes(marker), `${item.name} reflected a marker to stderr`);
    }
  }
});
