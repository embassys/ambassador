import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopInstances } from "../../dist/desktop/instances.js";

const application = fileURLToPath(new URL("../../.build/desktop/app", import.meta.url));
const packaged = process.argv.includes("--packaged");
const packageDirectory = fileURLToPath(
  new URL(
    `../../.build/desktop/packages/${process.platform === "linux" ? "AmbassadorDevelopment" : "Ambassador Development"}-${process.platform}-${process.arch}/`,
    import.meta.url,
  ),
);
const executable = packaged
  ? process.platform === "darwin"
    ? join(packageDirectory, "Ambassador Development.app/Contents/MacOS/AmbassadorDevelopment")
    : join(
        packageDirectory,
        process.platform === "win32" ? "AmbassadorDevelopment.exe" : "AmbassadorDevelopment",
      )
  : (await import("electron")).default;
const applicationArguments = packaged ? [] : [application];
const root = await mkdtemp(join(tmpdir(), "ambassador-host-probe-"));
const records = await DesktopInstances.open(join(root, "desktop"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const instance = await records.create({ name: "Host qualification", port });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const host = spawn(executable, [...applicationArguments, `--user-data-dir=${root}`], {
  env: environment,
  stdio: ["ignore", "ignore", "inherit"],
});
const exited = once(host, "exit");
const endpoint = `http://127.0.0.1:${port}/mcp`;
let started = false;
async function initialize() {
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(1000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "desktop-host-probe", version: "1" },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /serverInfo/u);
}
try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, "The Electron host exited before starting its server.");
    assert.equal(host.signalCode, null, "The Electron host crashed before starting its server.");
    try {
      await initialize();
      started = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(started, true, "The actual Electron host never started its configured server.");
  const registry = JSON.parse(await readFile(join(root, "desktop/instances.json"), "utf8"));
  assert.equal(registry.instances[0].id, instance.id);
  const second = spawn(executable, [...applicationArguments, `--user-data-dir=${root}`], {
    env: environment,
    stdio: "ignore",
    timeout: 15_000,
  });
  assert.equal((await once(second, "exit"))[0], 0);
  await initialize();
  console.log(
    "Actual Electron host started its isolated server; duplicate launch left it available.",
  );
} finally {
  host.kill("SIGTERM");
  let deadline;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Host did not stop.")), 40_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await initialize();
      await delay(100);
    } catch {
      break;
    }
  }
  if (started) await assert.rejects(initialize());
  await rm(root, { recursive: true, force: true });
}
