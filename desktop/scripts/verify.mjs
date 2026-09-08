import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const resourceArgument = process.argv.indexOf("--resources");
const suppliedResources = resourceArgument < 0 ? undefined : process.argv[resourceArgument + 1];
if (resourceArgument >= 0 && (!suppliedResources || !isAbsolute(suppliedResources)))
  throw new Error("The package test needs an absolute Resources directory.");
const packaged = process.argv.includes("--packaged") || !!suppliedResources;
const resources =
  suppliedResources ??
  (packaged
    ? join(
        repository,
        `.build/desktop/packages/Embassys-${process.platform}-${process.arch}`,
        process.platform === "darwin" ? "Embassys.app/Contents/Resources" : "resources",
      )
    : join(repository, ".build/desktop/app"));
const gateway = join(resources, "gateway");
const node = join(gateway, "runtime", process.platform === "win32" ? "node.exe" : "node");
const manifest = JSON.parse(
  await readFile(
    join(resources, packaged ? "app/build-manifest.json" : "build-manifest.json"),
    "utf8",
  ),
);
assert.equal(manifest.node, "24.19.0");
const probe = spawnSync(
  node,
  [
    "--input-type=module",
    "-e",
    `
import Database from 'better-sqlite3';
const database = new Database(':memory:');
if (database.prepare('select 42 as answer').get().answer !== 42) process.exit(1);
database.close();
if (process.version !== 'v24.19.0') process.exit(2);
`,
  ],
  {
    cwd: gateway,
    env: { ...process.env, PATH: join(gateway, "runtime"), NODE_OPTIONS: "" },
    encoding: "utf8",
  },
);
assert.equal(probe.status, 0, probe.stderr);
const resolve = createRequire(join(gateway, "package.json"));
assert.ok(resolve.resolve("@agentclientprotocol/sdk"));
assert.ok(resolve.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));
assert.ok(resolve.resolve("@agentclientprotocol/codex-acp/dist/index.js"));

const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const root = await mkdtemp(join(tmpdir(), "ambassador-packaged-desktop-"));
const id = randomUUID();
const child = fork(join(gateway, "dist/desktop/worker.js"), [], {
  execPath: node,
  execArgv: [],
  cwd: root,
  env: { ...process.env, PATH: join(gateway, "runtime"), NODE_OPTIONS: "" },
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const exited = once(child, "exit");
const limit = setTimeout(() => {
  child.kill();
  throw new Error("Packaged worker timed out.");
}, 30_000);
try {
  const ready = once(child, "message");
  child.send({
    protocol: 1,
    type: "initialize",
    instance: {
      id,
      name: "Package probe",
      port,
      stateDirectory: root,
      workingDirectory: join(root, "workspace"),
      enabled: false,
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal((await ready)[0].type, "ready");
  const started = new Promise((resolve) =>
    child.on("message", (value) => {
      if (value.type === "reply") resolve(value);
    }),
  );
  child.send({ protocol: 1, requestId: randomUUID(), command: { type: "start", instanceId: id } });
  const reply = await started;
  assert.equal(reply.ok, true);
  assert.equal(reply.result.state, "running", JSON.stringify(reply.result));
  const response = await fetch(reply.result.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "desktop-package-probe", version: "1" },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /serverInfo/u);
  const desktopClient = new Client({ name: "desktop-local-client-probe", version: "1" });
  try {
    await desktopClient.connect(
      new StdioClientTransport({
        command: node,
        args: [join(gateway, "dist/desktop-stdio.js")],
        env: { PATH: join(gateway, "runtime"), NODE_OPTIONS: "", EMBASSYS_MCP_PORT: String(port) },
        stderr: "pipe",
      }),
    );
    assert.match(desktopClient.getInstructions() ?? "", /Embassys app/u);
    assert.deepEqual((await desktopClient.listTools()).tools.map((tool) => tool.name).sort(), [
      "get_my_permissions",
      "list_action_types",
      "message_box",
      "register_agent",
      "resend_verification",
      "verify_email",
    ]);
    await assert.rejects(
      desktopClient.callTool({
        name: "register_agent",
        arguments: { email: "local-package-probe@fixture.test" },
      }),
      (error) => error.data?.code === "registration_in_app",
    );
  } finally {
    await desktopClient.close();
  }
  child.disconnect();
  assert.equal((await exited)[0], 0);
  console.log(
    "Packaged Node, SQLite, ACP dependency, real MCP worker and local desktop client passed with an isolated PATH.",
  );
} finally {
  clearTimeout(limit);
  if (child.connected) child.disconnect();
  await exited;
  await rm(root, { recursive: true, force: true });
}
