import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { startFakeCentral } from "./support/fake-central.js";
import { TestMcpClient } from "./support/mcp-client.js";

test("four-provider connection checks require actual MCP evidence and never repeat registration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-setup-flow-"));
  const central = await startFakeCentral();
  const id = randomUUID();
  let mode = "call";
  let started: (() => void) | undefined;
  const challenges = new Set<string>();
  const checked: string[] = [];
  const gateway = new DesktopGateway({
    id,
    name: "Setup",
    stateDirectory: root,
    workingDirectory: root,
    port: 0,
    environment: {},
    beforeDirectDelivery: async ({ agent }) => {
      checked.push(agent);
    },
    testOverrides: {
      centralOrigin: central.apiUrl,
      nowSeconds: () => 1_788_220_800,
      setupControllerFactory: () => ({
        async checkConnection(_cwd, challenge, _approve, signal) {
          assert.ok(!challenges.has(challenge));
          challenges.add(challenge);
          if (mode === "hang") {
            started?.();
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            return;
          }
          if (mode === "claim") return;
          const mcp = new TestMcpClient(gateway.snapshot().endpoint as string);
          await mcp.initialize({ name: "claude-code", version: "test" });
          await mcp.callTool("get_my_permissions", {
            setup_check: mode === "wrong" ? randomUUID() : challenge,
          });
        },
      }),
    },
  });
  t.after(async () => {
    await gateway.stop();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  await gateway.start();
  assert.equal((await gateway.testAgent("claude_code")).state, "configured");
  await gateway.desktopCommand({
    type: "enrollment_register",
    instanceId: id,
    email: "setup@fixture.test",
  });
  await gateway.desktopCommand({
    type: "enrollment_verify",
    instanceId: id,
    code: central.verificationCode("setup@fixture.test"),
  });
  assert.equal((await gateway.testAgent("claude_code")).state, "configured");
  await gateway.desktopCommand({ type: "enrollment_executor", instanceId: id, executor: "claude" });
  for (const provider of ["claude_code", "codex", "openclaw", "hermes"] as const)
    assert.equal((await gateway.testAgent(provider)).state, "verified", provider);
  mode = "claim";
  assert.equal((await gateway.testAgent("codex")).state, "configured");
  mode = "wrong";
  assert.equal((await gateway.testAgent("codex")).state, "configured");
  assert.deepEqual(checked.slice(0, 4), ["claude", "codex", "openclaw", "hermes"]);
  assert.equal(
    central.requests().filter((request) => request.path === "/api/register_agent").length,
    1,
  );
  assert.equal(
    central.requests().filter((request) => request.path === "/api/verify_email").length,
    1,
  );
  assert.equal(
    central
      .requests()
      .filter(
        (request) =>
          request.path === "/api/call_action" || request.path === "/api/request_permission",
      ).length,
    0,
  );
  mode = "hang";
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const checking = gateway.testAgent("codex");
  await running;
  assert.equal((await gateway.testAgent("hermes")).state, "configured");
  await gateway.stop();
  assert.equal((await checking).state, "configured");
  assert.equal(gateway.snapshot().state, "stopped");
});
