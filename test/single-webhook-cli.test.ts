import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("removed setup and agent-management commands are rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-removed-cli-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const stdout = writer();
  const stderr = writer();
  const secret = "obsolete-controller-secret-must-not-appear";

  const exitCode = await runCli(
    [
      "setup",
      "--controller-url",
      "https://controller.invalid",
      "--controller-token-env",
      "A2A_CONTROLLER_TOKEN",
      "--config",
      join(directory, "config.json"),
    ],
    {
      cwd: directory,
      env: { A2A_CONTROLLER_TOKEN: secret },
      io: { stdout: stdout.stream, stderr: stderr.stream },
    },
  );

  assert.equal(exitCode, 2);
  assert.ok(!stdout.read().includes(secret));
  assert.ok(!stderr.read().includes(secret));
});

test("split startup options and literal token options are rejected", async () => {
  for (const args of [
    [
      "start",
      "--webhook-url",
      "http://127.0.0.1:18789/hooks/agent",
      "--webhook-token-env",
      "A2A_WEBHOOK_TOKEN",
    ],
    ["start", "--webhook-url=http://127.0.0.1:18789/hooks/agent", "--webhook-token=literal-secret"],
  ]) {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runCli(args, {
      cwd: process.cwd(),
      env: { A2A_WEBHOOK_TOKEN: "test-token" },
      io: { stdout: stdout.stream, stderr: stderr.stream },
    });
    assert.equal(exitCode, 2);
    assert.ok(!stdout.read().includes("literal-secret"));
    assert.ok(!stderr.read().includes("literal-secret"));
  }
});
