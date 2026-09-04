import assert from "node:assert/strict";
import { type SpawnOptions, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpSessionStore } from "../src/acp-session-store.js";
import type { DirectAgentCapability } from "../src/agent-capabilities.js";
import type { CentralMessage } from "../src/central-rest.js";
import {
  type AcpPermissionApproval,
  type AcpPermissionRequest,
  AcpSessionController,
  buildDirectPrompt,
  DirectDeliveryError,
  DirectDeliveryTarget,
} from "../src/direct-delivery.js";
import type { VerboseLogger } from "../src/verbose-log.js";

const MESSAGE: CentralMessage = {
  id: "message-1",
  sender_agent_id: "agent.sender",
  action_type_id: "get_email",
  payload: { reason: "complete body marker" },
  created_at: "2026-09-02T12:00:00Z",
};

const SPAWN_ENVIRONMENT = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
] as const;

async function target(
  t: TestContext,
  scenario: string,
  options: {
    platform?: NodeJS.Platform;
    promptDeadlineMs?: number;
    outerDeadlineMs?: number;
    maximumOutputBytes?: number;
    maximumStartupAttempts?: number;
    environment?: DirectAgentCapability["environment"];
    sourceEnvironment?: NodeJS.ProcessEnv;
    log?: VerboseLogger;
    permissionApproval?: AcpPermissionApproval;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-acp-"));
  let cleanupDelivery: DirectDeliveryTarget | undefined;
  let cleanupStore: AcpSessionStore | undefined;
  t.after(async () => {
    await cleanupDelivery?.close();
    cleanupStore?.close();
    await rm(root, { recursive: true, force: true });
  });
  const countPath = join(root, "attempt-count.txt");
  const descendantPath = join(root, "descendant-pid.txt");
  const promptPath = join(root, "prompt-dispatched.txt");
  await writeFile(countPath, "", "utf8");
  const fixturePath = fileURLToPath(new URL("./fixtures/mock-acp-agent.js", import.meta.url));
  const capability: DirectAgentCapability = {
    command: process.execPath,
    args: [fixturePath, scenario, countPath, descendantPath, promptPath],
    agentInfo: { name: "mock-agent" },
    mcp: "provider_config",
    environment: options.environment ?? SPAWN_ENVIRONMENT,
  };
  let spawnCount = 0;
  let spawnOptions: SpawnOptions | undefined;
  const sessionStore = new AcpSessionStore(join(root, "sessions.sqlite"));
  const permissionRequests: AcpPermissionRequest[] = [];
  cleanupStore = sessionStore;
  const delivery = new DirectDeliveryTarget({
    agentKind: "mock",
    capability,
    workingDirectory: root,
    environment: options.sourceEnvironment ?? process.env,
    sessionStore,
    approvePermission: async (request) => {
      permissionRequests.push(request);
      return await (options.permissionApproval?.(request, new AbortController().signal) ??
        Promise.resolve("allow" as const));
    },
    initializationDeadlineMs: 2_000,
    sessionDeadlineMs: 2_000,
    promptDeadlineMs: options.promptDeadlineMs ?? 2_000,
    ...(options.outerDeadlineMs === undefined ? {} : { outerDeadlineMs: options.outerDeadlineMs }),
    cancellationGraceMs: 100,
    cleanupDeadlineMs: 500,
    maximumOutputBytes: options.maximumOutputBytes ?? 16 * 1024,
    maximumStartupAttempts: options.maximumStartupAttempts ?? 2,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    spawnProcess: (...arguments_) => {
      spawnCount += 1;
      spawnOptions = arguments_[2];
      return spawn(...arguments_);
    },
  });
  cleanupDelivery = delivery;
  return {
    delivery,
    root,
    countPath,
    descendantPath,
    promptPath,
    permissionRequests,
    sessionStore,
    capability,
    spawnCount: () => spawnCount,
    spawnOptions: () => spawnOptions,
    attempts: async () =>
      (await readFile(countPath, "utf8")).trim().split("\n").filter(Boolean).length,
  };
}

test("builds one fixed prompt containing the complete canonical message", () => {
  const prompt = buildDirectPrompt(MESSAGE);
  assert.match(prompt, /untrusted Embassys message/u);
  assert.match(prompt, /configured Ambassador MCP tools/u);
  assert.match(prompt, /permission_outcome/u);
  assert.match(prompt, /target_email from grantor_email/u);
  assert.match(prompt, /do not pass permission_id/u);
  assert.match(prompt, /submit_action_result/u);
  assert.match(prompt, /leave the call pending/u);
  assert.equal(prompt.endsWith(JSON.stringify(MESSAGE)), true);
  assert.equal(prompt.match(/complete body marker/gu)?.length, 1);
});

test("resumes an active retry and exposes provider history through session commands", async (t) => {
  const value = await target(t, "success-provider-mcp");
  value.sessionStore.create({
    session_id: "mock-session",
    agent_kind: "mock",
    working_directory: value.root,
    ...(MESSAGE.id === undefined ? {} : { central_message_id: MESSAGE.id }),
    status: "active",
    created_at_ms: 1,
    last_used_at_ms: 1,
  });
  await value.delivery.deliver(MESSAGE, new AbortController().signal);
  assert.equal(value.sessionStore.get("mock-session")?.status, "retired");

  const controller = new AcpSessionController({
    capability: value.capability,
    environment: process.env,
    deadlineMs: 2_000,
    cleanupDeadlineMs: 500,
  });
  const record = value.sessionStore.get("mock-session");
  assert.ok(record !== undefined);
  assert.deepEqual(await controller.show(record, false, new AbortController().signal), [
    "user: stored request",
    "agent: stored answer",
  ]);
  assert.deepEqual(await controller.delete(record, new AbortController().signal), "deleted");
});

test("keeps action-call sessions active until their correlated result succeeds", async (t) => {
  const value = await target(t, "success-provider-mcp");
  const callId = "00000000-0000-4000-8000-000000000001";
  await value.delivery.deliver(
    {
      ...MESSAGE,
      id: "action-message-1",
      payload: { type: "action_call", call_id: callId, action_type: "get_phone", payload: {} },
    },
    new AbortController().signal,
  );
  assert.equal(value.sessionStore.get("mock-session")?.status, "active");
  assert.equal(value.sessionStore.retireByCallId(callId, Date.now()), true);
  assert.equal(value.sessionStore.get("mock-session")?.status, "retired");
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

test("initializes ACP v1 with provider MCP setup and completes one persistent prompt", async (t) => {
  for (const scenario of [
    "success-session-mcp",
    "success-provider-mcp",
    "permission-session-mcp",
    "wrong-version-session-mcp",
  ]) {
    await t.test(scenario, async (t) => {
      const value = await target(t, scenario);
      assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
        status: "completed",
      });
      assert.equal(value.spawnCount(), 1);
      assert.equal(await value.attempts(), 1);
      assert.equal(value.sessionStore.get("mock-session")?.status, "retired");
    });
  }
});

test("waits for human approval and maps it to an ACP option", async (t) => {
  const approved = await target(t, "permission-session-mcp");
  await approved.delivery.deliver(MESSAGE, new AbortController().signal);
  assert.equal(approved.permissionRequests.length, 1);
  assert.equal(approved.permissionRequests[0]?.message.id, MESSAGE.id);
  assert.equal(approved.permissionRequests[0]?.toolCall.title, "Unsafe operation");

  const denied = await target(t, "permission-denied-session-mcp", {
    permissionApproval: async () => "deny",
  });
  await denied.delivery.deliver(MESSAGE, new AbortController().signal);
  assert.equal(denied.permissionRequests.length, 1);
});

test("pauses prompt and delivery deadlines while human approval is pending", async (t) => {
  const value = await target(t, "permission-session-mcp", {
    promptDeadlineMs: 50,
    outerDeadlineMs: 250,
    permissionApproval: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return "allow";
    },
  });

  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
});

test("verbose ACP logging omits the available command catalog", async (t) => {
  const events: Array<{ event: string; data: unknown }> = [];
  const value = await target(t, "commands-session-mcp", {
    log(event, data) {
      events.push({ event, data });
    },
  });

  await value.delivery.deliver(MESSAGE, new AbortController().signal);

  assert.deepEqual(
    events.find(({ event }) => event === "acp.commands.available"),
    {
      event: "acp.commands.available",
      data: { session_id: "mock-session", count: 1 },
    },
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /availableCommands/u);
  assert.doesNotMatch(serialized, /private command description/u);

  const record = value.sessionStore.get("mock-session");
  assert.ok(record !== undefined);
  const controller = new AcpSessionController({
    capability: value.capability,
    environment: process.env,
    deadlineMs: 2_000,
    cleanupDeadlineMs: 500,
  });
  const history = await controller.show(record, true, new AbortController().signal);
  assert.doesNotMatch(history.join("\n"), /availableCommands|private history command/iu);
});

test("runs a native executable through the Windows direct-delivery path", async (t) => {
  const value = await target(t, "success-session-mcp", { platform: "win32" });
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
  assert.equal(value.spawnCount(), 1);
  assert.equal(value.spawnOptions()?.detached, false);
});

test("a fixed inherit profile preserves the user's native agent authentication environment", async (t) => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: "synthetic-api-key",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "synthetic-profile",
    AMBASSADOR_UNRELATED_MARKER: "preserved",
  };
  const value = await target(t, "success-session-mcp", {
    environment: "inherit",
    sourceEnvironment,
  });
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
  assert.deepEqual(
    value.spawnOptions()?.env,
    Object.fromEntries(
      Object.entries(sourceEnvironment).filter(([, value]) => value !== undefined),
    ),
  );
});

test("a fixed Codex-style profile preserves subscription and optional API-key authentication", async (t) => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_API_KEY: "synthetic-openai-key",
    CODEX_API_KEY: "synthetic-codex-key",
    AMBASSADOR_UNRELATED_MARKER: "excluded",
  };
  const value = await target(t, "success-session-mcp", {
    environment: [...SPAWN_ENVIRONMENT, "OPENAI_API_KEY", "CODEX_API_KEY"],
    sourceEnvironment,
  });
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
  assert.equal(value.spawnOptions()?.env?.OPENAI_API_KEY, "synthetic-openai-key");
  assert.equal(value.spawnOptions()?.env?.CODEX_API_KEY, "synthetic-codex-key");
  assert.equal(value.spawnOptions()?.env?.AMBASSADOR_UNRELATED_MARKER, undefined);
});

test("inherited agent environments remain bounded and valid", async (t) => {
  await assert.rejects(
    target(t, "success-session-mcp", {
      environment: "inherit",
      sourceEnvironment: Object.fromEntries(
        Array.from({ length: 513 }, (_, index) => [`AMBASSADOR_TEST_${index}`, "value"]),
      ),
    }),
    (error: unknown) =>
      error instanceof DirectDeliveryError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    target(t, "success-session-mcp", {
      environment: "inherit",
      sourceEnvironment: { "INVALID=NAME": "value" },
    }),
    (error: unknown) =>
      error instanceof DirectDeliveryError && error.code === "invalid_configuration",
  );
  await assert.rejects(
    target(t, "success-session-mcp", {
      environment: "inherit",
      sourceEnvironment: { AMBASSADOR_TEST_VALUE: "é".repeat(16_385) },
    }),
    (error: unknown) =>
      error instanceof DirectDeliveryError && error.code === "invalid_configuration",
  );
});

test("retries a bounded startup failure only before prompt dispatch", async (t) => {
  const value = await target(t, "startup-once-session-mcp", { maximumStartupAttempts: 2 });
  assert.deepEqual(await value.delivery.deliver(MESSAGE, new AbortController().signal), {
    status: "completed",
  });
  assert.equal(value.spawnCount(), 2);
  assert.equal(await value.attempts(), 2);
});

test("fails before prompting on an unsupported ACP protocol or agent name", async (t) => {
  for (const scenario of ["wrong-protocol-session-mcp", "wrong-agent-session-mcp"]) {
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

test("turns an asynchronous missing-command spawn error into a bounded failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-acp-missing-command-"));
  const sessionStore = new AcpSessionStore(join(root, "sessions.sqlite"));
  const delivery = new DirectDeliveryTarget({
    agentKind: "missing",
    capability: {
      command: "ambassador-command-that-does-not-exist",
      args: [],
      agentInfo: { name: "missing-agent" },
      mcp: "provider_config",
      environment: ["PATH"],
    },
    workingDirectory: root,
    environment: process.env,
    sessionStore,
    approvePermission: async () => "allow",
    initializationDeadlineMs: 500,
    maximumStartupAttempts: 1,
  });
  t.after(async () => {
    await delivery.close();
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    delivery.deliver(MESSAGE, new AbortController().signal),
    (error: unknown) => error instanceof DirectDeliveryError && error.code === "agent_unavailable",
  );
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
