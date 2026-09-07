import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { desktopCredentialStores } from "../../dist/desktop/credential-stores.js";
import { defaultGatewayPaths } from "../../dist/gateway-paths.js";
import { LocalControlClient } from "../../dist/local-control.js";

const root = await mkdtemp(join(tmpdir(), "embassys-shared-host-"));
const home = join(root, "home");
await mkdir(home);
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_STATE_HOME: join(home, ".local", "state"),
};
delete environment.ELECTRON_RUN_AS_NODE;
const paths = defaultGatewayPaths(process.platform, environment, home);
const userData = join(root, "app");
const packageRoot = fileURLToPath(
  new URL(
    `../../.build/desktop/packages/Embassys-${process.platform}-${process.arch}/`,
    import.meta.url,
  ),
);
const executable =
  process.platform === "darwin"
    ? join(packageRoot, "Embassys.app/Contents/MacOS/Embassys")
    : join(packageRoot, process.platform === "win32" ? "Embassys.exe" : "Embassys");
const runtime =
  process.platform === "darwin"
    ? join(packageRoot, "Embassys.app/Contents/Resources/gateway")
    : join(packageRoot, "resources/gateway");
const nodePath = join(runtime, "runtime", process.platform === "win32" ? "node.exe" : "node");
const endpoint = "http://127.0.0.1:8787/mcp";
const children = new Set();
const evidence = { checks: [], platform: process.platform, passed: false };
function launch(command, args) {
  const child = spawn(command, args, {
    env: environment,
    cwd: home,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function until(check, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail("The shared installation did not reach the expected state.");
}
async function ready() {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      signal: AbortSignal.timeout(1000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "shared-host-probe", version: "1" },
        },
      }),
    });
    const text = await response.text();
    return response.status === 200 && text.includes("serverInfo");
  } catch {
    return false;
  }
}
async function control() {
  const secret = await desktopCredentialStores(paths).localControlSecretStore.load();
  assert.ok(secret);
  return new LocalControlClient(endpoint, secret);
}
async function stopServer() {
  const client = await control();
  await client.stopProcess(await client.getProcessInstance());
  await until(async () => !(await ready()));
}
async function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  await stopped;
}
try {
  assert.equal(await ready(), false, "Port 8787 is occupied; no existing server was stopped.");
  const first = launch(nodePath, [join(runtime, "dist/cli.js"), "start"]);
  await until(ready);
  const firstControl = await control();
  const firstId = await firstControl.getProcessInstance();
  const marker = join(paths.stateDirectory, "handoff-marker.txt");
  await writeFile(marker, "This installation stays in place.", { mode: 0o600 });
  const firstExit = once(first, "exit");
  await stopServer();
  await firstExit;
  evidence.checks.push("packaged CLI starts and stops through its authenticated control route");
  const app = launch(executable, [`--user-data-dir=${userData}`, "--background"]);
  await until(ready);
  const appControl = await control();
  assert.notEqual(await appControl.getProcessInstance(), firstId);
  const registryPath = join(userData, "desktop", "instances.json");
  const registry = () => readFile(registryPath, "utf8").then(JSON.parse);
  const registered = (await registry()).instances;
  assert.equal(registered.length, 1);
  assert.equal(registered[0].source, "cli");
  assert.equal(registered[0].enabled, true);
  assert.equal(await readFile(marker, "utf8"), "This installation stays in place.");
  await stopServer();
  await until(async () => (await registry()).instances[0].enabled === false);
  evidence.checks.push(
    "fresh app opens the CLI installation and persists a confirmed external stop",
  );
  const second = launch(nodePath, [join(runtime, "dist/cli.js"), "start"]);
  await until(ready);
  const secondId = await (await control()).getProcessInstance();
  await exit(app);
  const reopened = launch(executable, [`--user-data-dir=${userData}`, "--background"]);
  await delay(3000);
  assert.equal(reopened.exitCode, null);
  assert.equal(await (await control()).getProcessInstance(), secondId);
  assert.equal((await registry()).instances[0].enabled, false);
  assert.equal(await readFile(marker, "utf8"), "This installation stays in place.");
  evidence.checks.push(
    "CLI restarts; reopening the app neither restarts nor interrupts the shared server",
  );
  await exit(reopened);
  const secondExit = once(second, "exit");
  await stopServer();
  await secondExit;
  evidence.passed = true;
} finally {
  for (const child of children) await exit(child);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await writeFile(
    fileURLToPath(new URL("../../.build/desktop/shared-host-qualification.json", import.meta.url)),
    JSON.stringify(evidence, null, 2),
  );
}
console.log("Packaged CLI → app → CLI handoff and app restart passed with isolated user data.");
