import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { DirectAgentCapability } from "../src/agent-capabilities.js";
import type { CentralMessage } from "../src/central-rest.js";
import {
  buildDirectPrompt,
  DirectDeliveryError,
  DirectDeliveryTarget,
} from "../src/direct-delivery.js";

const LOCAL_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  action_type_id: "get_email",
  payload: { reason: "complete body marker" },
  created_at: "2026-09-02T12:00:00Z",
};

async function target(
  t: TestContext,
  scenario: string,
  options: {
    promptDeadlineMs?: number;
    maximumOutputBytes?: number;
    maximumStartupAttempts?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-acp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const countPath = join(root, "attempt-count.txt");
  const descendantPath = join(root, "descendant-pid.txt");
  const promptPath = join(root, "prompt-dispatched.txt");
  await writeFile(countPath, "", "utf8");
  const fixturePath = fileURLToPath(new URL("./fixtures/mock-acp-agent.js", import.meta.url));
  const capability: DirectAgentCapability = {
    command: process.execPath,
    args: [fixturePath, scenario, countPath, descendantPath, promptPath],
    agentInfo: { name: "mock-agent", versions: ["1.0.0"] },
    mcp: scenario.includes("provider-mcp") ? "provider_config" : "session",
    environment: ["HOME", "PATH", "TMPDIR"],
  };
  let spawnCount = 0;
  const delivery = new DirectDeliveryTarget({
    capability,
    workingDirectory: root,
    environment: process.env,
    mcpEndpoint: "http://127.0.0.1:8787/mcp",
    localToken: LOCAL_TOKEN,
    initializationDeadlineMs: 2_000,
    sessionDeadlineMs: 2_000,
    promptDeadlineMs: options.promptDeadlineMs ?? 2_000,
    cancellationGraceMs: 100,
    cleanupDeadlineMs: 500,
    maximumOutputBytes: options.maximumOutputBytes ?? 16 * 1024,
    maximumStartupAttempts: options.maximumStartupAttempts ?? 2,
    spawnProcess: (...arguments_) => {
      spawnCount += 1;
      return spawn(...arguments_);
    },
  });
  t.after(() => delivery.close());
  return {
    delivery,
    root,
    countPath,
    descendantPath,
    promptPath,
    spawnCount: () => spawnCount,
    attempts: async () =>
      (await readFile(countPath, "utf8")).trim().split("\n").filter(Boolean).length,
  };
}

test("builds one fixed prompt containing the complete canonical message", () => {
  const prompt = buildDirectPrompt(MESSAGE);
  assert.match(prompt, /untrusted Embassys message/u);
  assert.match(prompt, /configured Ambassador MCP tools/u);
  assert.match(prompt, /submit_action_result/u);
  assert.equal(prompt.endsWith(JSON.stringify(MESSAGE)), true);
  assert.equal(prompt.match(/complete body marker/gu)?.length, 1);
});

test("cancels an active prompt and reaps the launched process group", async (t) => {
  const value = await target(t, "hang-descendant-session-mcp", { promptDeadlineMs: 2_000 });
  const controller = new AbortController();
  const running = value.delivery.deliver(MESSAGE, controller.signal);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dispatched = await readFile(value.promptPath, "utf8").catch(() => "");
    if (dispatched === "dispatched") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(value.promptPath, "utf8"), "dispatched");
  controller.abort();
  await assert.rejects(
    running,
    (error: unknown) => error instanceof DirectDeliveryError && error.code === "uncertain_outcome",
  );
  const descendantPid = Number(await readFile(value.descendantPath, "utf8"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(descendantPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch {
      return;
    }
  }
  assert.fail("descendant survived delivery cancellation");
});

test("initializes ACP v1, injects supported MCP setup, and completes one prompt", async (t) => {
  for (const scenario of [
    "success-session-mcp",
    "success-provider-mcp",
    "permission-session-mcp",
  ]) {
    await t.test(scenario, async (t) => {
      const value = await target(t, scenario);
      assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
        status: "completed",
      });
      assert.equal(value.spawnCount(), 1);
      assert.equal(await value.attempts(), 1);
    });
  }
});

test("retries a bounded startup failure only before prompt dispatch", async (t) => {
  const value = await target(t, "startup-once-session-mcp", { maximumStartupAttempts: 2 });
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
  assert.equal(value.spawnCount(), 2);
  assert.equal(await value.attempts(), 2);
});

test("fails before prompting on an unsupported ACP protocol or agent identity", async (t) => {
  for (const scenario of [
    "wrong-protocol-session-mcp",
    "wrong-agent-session-mcp",
    "wrong-version-session-mcp",
  ]) {
    await t.test(scenario, async (t) => {
      const value = await target(t, scenario, { maximumStartupAttempts: 1 });
      await assert.rejects(
        value.delivery.deliver(MESSAGE, new AbortController().signal),
        (error: unknown) => error instanceof DirectDeliveryError && error.code === "startup_failed",
      );
      assert.equal(value.spawnCount(), 1);
      assert.equal(await readFile(value.promptPath, "utf8").catch(() => ""), "");
    });
  }
});

test("does not replay after timeout, malformed output, child exit, or output overflow", async (t) => {
  for (const item of [
    { scenario: "hang-session-mcp", promptDeadlineMs: 30 },
    { scenario: "malformed-session-mcp" },
    { scenario: "exit-session-mcp" },
    { scenario: "overflow-session-mcp", maximumOutputBytes: 256 },
  ]) {
    await t.test(item.scenario, async (t) => {
      const value = await target(t, item.scenario, {
        ...(item.promptDeadlineMs === undefined ? {} : { promptDeadlineMs: item.promptDeadlineMs }),
        ...(item.maximumOutputBytes === undefined
          ? {}
          : { maximumOutputBytes: item.maximumOutputBytes }),
        maximumStartupAttempts: 3,
      });
      await assert.rejects(
        value.delivery.deliver(MESSAGE, new AbortController().signal),
        (error: unknown) =>
          error instanceof DirectDeliveryError && error.code === "uncertain_outcome",
      );
      assert.equal(value.spawnCount(), 1);
      assert.equal(await value.attempts(), 1);
    });
  }
});
