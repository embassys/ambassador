import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ConnectionProvider, connectionEntry } from "../src/desktop/agent-connections.js";
import { verifyExecutorConnection } from "../src/desktop/executor-connection.js";

test("each executor checks its selected instance again before delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-executor-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "work");
  await mkdir(workingDirectory);
  for (const provider of ["claude_code", "openclaw", "codex", "hermes"] as ConnectionProvider[]) {
    const configurationPath = join(root, `${provider}.json`);
    const body = (entry: unknown) =>
      provider === "claude_code"
        ? { mcpServers: { ambassador: entry } }
        : provider === "openclaw"
          ? { mcp: { servers: { ambassador: entry } } }
          : { mcp_servers: { ambassador: entry } };
    const options = {
      provider,
      configurationPath,
      workingDirectory,
      port: 9797,
      ...(["codex", "hermes"].includes(provider)
        ? {
            document: {
              read: (value: string) => JSON.parse(value).mcp_servers?.ambassador,
              edit: () => {
                throw new Error("read only");
              },
            },
          }
        : {}),
    };
    assert.equal(await verifyExecutorConnection(options), false);
    await writeFile(configurationPath, JSON.stringify(body(connectionEntry(provider, 9797))));
    assert.equal(await verifyExecutorConnection(options), true);
    assert.equal(await verifyExecutorConnection({ ...options, port: 8787 }), false);
    for (const changed of [
      connectionEntry(provider, 8787),
      { ...connectionEntry(provider, 9797), enabled: false },
      { ...connectionEntry(provider, 9797), headers: { Authorization: "never-forward" } },
      { ...connectionEntry(provider, 9797), url: "https://example.test/mcp" },
    ]) {
      await writeFile(configurationPath, JSON.stringify(body(changed)));
      assert.equal(await verifyExecutorConnection(options), false);
    }
    await writeFile(configurationPath, "invalid");
    assert.equal(await verifyExecutorConnection(options), false);
  }
});

test("project overrides, disabled OpenClaw MCP and linked config cannot redirect delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-executor-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "project", "child");
  await mkdir(workingDirectory, { recursive: true });
  const configurationPath = join(root, "provider.json");
  const options = {
    provider: "claude_code" as const,
    configurationPath,
    workingDirectory,
    port: 9797,
  };
  const global = { mcpServers: { ambassador: connectionEntry("claude_code", 9797) } };
  await writeFile(configurationPath, JSON.stringify(global));
  assert.equal(await verifyExecutorConnection(options), true);
  const project = join(root, "project", ".mcp.json");
  await writeFile(
    project,
    JSON.stringify({ mcpServers: { ambassador: connectionEntry("claude_code", 8787) } }),
  );
  assert.equal(await verifyExecutorConnection(options), false);
  await rm(project);
  await writeFile(
    configurationPath,
    JSON.stringify({
      ...global,
      projects: { [workingDirectory]: { mcpServers: global.mcpServers } },
    }),
  );
  assert.equal(await verifyExecutorConnection(options), false);
  await writeFile(
    configurationPath,
    JSON.stringify({
      mcp: { enabled: false, servers: { ambassador: connectionEntry("openclaw", 9797) } },
    }),
  );
  assert.equal(await verifyExecutorConnection({ ...options, provider: "openclaw" }), false);
  if (process.platform !== "win32") {
    const linked = join(root, "linked.json");
    await symlink(configurationPath, linked);
    assert.equal(await verifyExecutorConnection({ ...options, configurationPath: linked }), false);
  }
});
