import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationPlan } from "./qualify-platform-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plan = qualificationPlan(process.argv.slice(2), {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
});
const pnpm = process.env.npm_execpath;
if (!pnpm || !/pnpm\.(?:c?js|mjs)$/.test(pnpm))
  throw new Error("Run this script through pnpm qualify:platform.");
const temporary = await mkdtemp(join(tmpdir(), "embassys-full-platform-"));
const install = join(temporary, "installed");
const tarball = join(temporary, "embassys.tgz");
const reportDirectory = join(root, ".build", "platform-qualification");
const reportPath = join(reportDirectory, `${process.platform}-${process.arch}.json`);
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  startedAt: new Date().toISOString(),
  passed: false,
  stages: [],
};
await mkdir(install);
await mkdir(reportDirectory, { recursive: true });
async function saveReport() {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
try {
  for (const step of plan) {
    const args = step.args.map((arg) =>
      arg === "{install}" ? install : arg === "{tarball}" ? tarball : arg,
    );
    const stage = {
      name: step.name,
      startedAt: new Date().toISOString(),
      seconds: 0,
      passed: false,
    };
    report.stages.push(stage);
    await saveReport();
    const started = performance.now();
    console.log(`\nPlatform qualification: ${step.name}`);
    try {
      const environment = {
        ...process.env,
        PNPM_CONFIG_MINIMUM_RELEASE_AGE: "1440",
        PNPM_CONFIG_MINIMUM_RELEASE_AGE_STRICT: "true",
        PNPM_CONFIG_BLOCK_EXOTIC_SUBDEPS: "true",
      };
      delete environment.AMBASSADOR_PACKED_CLI;
      if (step.name === "installed-flows") {
        environment.AMBASSADOR_PACKED_CLI = join(
          install,
          "node_modules",
          "embassys",
          "dist",
          "cli.js",
        );
      }
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, step.tool === "pnpm" ? [pnpm, ...args] : args, {
          cwd: root,
          stdio: "inherit",
          env: environment,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          code === 0 ? resolve() : reject(new Error(`${step.name} failed (${signal || code})`)),
        );
      });
      stage.passed = true;
    } finally {
      stage.seconds = Math.round((performance.now() - started) / 100) / 10;
      await saveReport();
    }
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await saveReport();
  console.log(`Qualification report: ${reportPath}`);
}
