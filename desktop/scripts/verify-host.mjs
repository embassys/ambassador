import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopInstances } from "../../dist/desktop/instances.js";

const application = fileURLToPath(new URL("../../.build/desktop/app", import.meta.url));
const packaged = process.argv.includes("--packaged");
const measureMemory = process.argv.includes("--measure-memory");
if (measureMemory && process.platform !== "darwin")
  throw new Error("Physical-footprint qualification currently requires macOS.");
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
const host = spawn(
  executable,
  [...applicationArguments, `--user-data-dir=${root}`, "--background"],
  {
    env: environment,
    stdio: ["ignore", "ignore", "inherit"],
  },
);
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
  if (measureMemory) {
    await delay(3000);
    const processes = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,time=,command="], {
      encoding: "utf8",
    });
    assert.equal(processes.status, 0);
    const rows = processes.stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
      return match
        ? [{ pid: Number(match[1]), parent: Number(match[2]), cpu: match[3], command: match[4] }]
        : [];
    });
    const ids = new Set([host.pid]);
    let count;
    do {
      count = ids.size;
      for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
    } while (ids.size !== count);
    const owned = rows.filter((row) => ids.has(row.pid));
    // Electron may prewarm a renderer even without a BrowserWindow. Count it
    // in physical memory; a process label is not evidence of a visible window.
    assert.equal(owned.filter((row) => row.command.startsWith("Ambassador: ")).length, 1);
    const output = join(application, "..", "host-footprint.json");
    const footprint = spawnSync(
      "/usr/bin/footprint",
      ["--noCategories", "--json", output, ...[...ids].map(String)],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(footprint.status, 0, footprint.stderr);
    const measured = JSON.parse(await readFile(output, "utf8"));
    assert.equal(measured.errors.length, 0);
    const cpuSeconds = (value) => {
      const parts = value.split(":").map(Number);
      return parts.reduce((seconds, part) => seconds * 60 + part, 0);
    };
    const initialCpu = owned.reduce((total, row) => total + cpuSeconds(row.cpu), 0);
    const sampleStarted = performance.now();
    await delay(10_000);
    const finalCpu = spawnSync("/bin/ps", ["-p", [...ids].join(","), "-o", "time="], {
      encoding: "utf8",
    });
    assert.equal(finalCpu.status, 0);
    const times = finalCpu.stdout.trim().split(/\s+/u);
    assert.equal(times.length, owned.length, "The idle process set changed during measurement.");
    const cpuPercent =
      ((times.reduce((total, time) => total + cpuSeconds(time), 0) - initialCpu) /
        ((performance.now() - sampleStarted) / 1000)) *
      100;
    const report = {
      measuredAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      processor: cpus()[0]?.model,
      workload: "One unenrolled instance; no providers; background launch",
      footprintBytes: measured["total footprint"],
      idleCpuPercent: cpuPercent,
      processCount: owned.length,
    };
    await writeFile(
      join(application, "..", "host-resource-qualification.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `Background physical footprint: ${(measured["total footprint"] / 1024 / 1024).toFixed(1)} MiB across ${owned.length} app processes. Evidence: ${output}`,
    );
    assert.ok(
      measured["total footprint"] < 250 * 1024 * 1024,
      "The provisional background memory budget was exceeded.",
    );
    console.log(`Idle CPU over ten seconds: ${cpuPercent.toFixed(2)}% of one core.`);
    assert.ok(cpuPercent < 1, "The provisional idle CPU budget was exceeded.");
  }
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
