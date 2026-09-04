import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { DirectAgentCapability } from "../src/agent-capabilities.js";
import type { CentralMessage } from "../src/central-rest.js";
import { DirectDeliveryError, DirectDeliveryTarget } from "../src/direct-delivery.js";

const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  payload: { type: "action_call", value: "private prompt marker" },
  created_at: "2026-09-04T12:00:00Z",
};

async function fixture(t: TestContext, scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-claude-cli-acp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "claude-invocations.jsonl");
  await writeFile(logPath, "", "utf8");
  const launcher = fileURLToPath(new URL("./fixtures/claude-cli-acp-launcher.js", import.meta.url));
  const mockCli = fileURLToPath(new URL("./fixtures/mock-claude-cli.js", import.meta.url));
  const capability: DirectAgentCapability = {
    command: process.execPath,
    args: [launcher, mockCli, scenario, logPath],
    agentInfo: { name: "@embassys/claude-cli-acp" },
    mcp: "session",
    environment: ["HOME", "PATH", "TMPDIR"],
  };
  const delivery = new DirectDeliveryTarget({
    capability,
    workingDirectory: root,
    environment: process.env,
    mcpEndpoint: "http://127.0.0.1:8787/mcp",
    initializationDeadlineMs: 2_000,
    sessionDeadlineMs: 2_000,
    promptDeadlineMs: 2_000,
    cancellationGraceMs: 20,
    cleanupDeadlineMs: 500,
    maximumStartupAttempts: 1,
  });
  t.after(() => delivery.close());
  return { delivery, logPath };
}

test("Claude ACP bridge uses the installed CLI login and an isolated Ambassador MCP session", async (t) => {
  const value = await fixture(t, "success");
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });

  const calls = (await readFile(value.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; input: string });
  assert.deepEqual(calls[0], { args: ["auth", "status"], input: "" });
  const promptCall = calls[1];
  assert.ok(promptCall !== undefined);
  assert.equal(promptCall.args.includes("--print"), true);
  assert.equal(promptCall.args.includes("--safe-mode"), true);
  assert.equal(promptCall.args.includes("--strict-mcp-config"), true);
  assert.equal(promptCall.args.includes("--no-session-persistence"), true);
  assert.equal(promptCall.args.includes("--permission-prompts"), true);
  assert.equal(promptCall.args.includes("none"), true);
  assert.equal(promptCall.args.includes("--tools"), true);
  assert.equal(promptCall.args.includes(""), true);
  const mcpIndex = promptCall.args.indexOf("--mcp-config");
  assert.notEqual(mcpIndex, -1);
  assert.deepEqual(JSON.parse(promptCall.args[mcpIndex + 1] ?? ""), {
    mcpServers: {
      ambassador: { type: "http", url: "http://127.0.0.1:8787/mcp" },
    },
  });
  assert.match(promptCall.input, /untrusted Embassys message/u);
  assert.match(promptCall.input, /private prompt marker/u);
});

test("Claude ACP bridge rejects a signed-out CLI before prompt submission", async (t) => {
  const value = await fixture(t, "signed-out");
  await assert.rejects(
    value.delivery.deliver(MESSAGE, new AbortController().signal),
    (error: unknown) => error instanceof DirectDeliveryError && error.code === "startup_failed",
  );
  const calls = (await readFile(value.logPath, "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
});

test("Claude ACP bridge does not reflect provider failure details", async (t) => {
  const value = await fixture(t, "prompt-failure");
  await assert.rejects(
    value.delivery.deliver(MESSAGE, new AbortController().signal),
    (error: unknown) =>
      error instanceof DirectDeliveryError &&
      error.code === "uncertain_outcome" &&
      !String(error).includes("private provider failure"),
  );
});
