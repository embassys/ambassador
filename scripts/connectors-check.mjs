import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = ["codex", "claude", "gemini"];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function run(executable, arguments_) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else reject(new Error("connector check command failed"));
    });
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("connectors:check accepts no arguments");

  await run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"]);
  for (const provider of PROVIDERS) {
    await run(process.execPath, [join(repositoryRoot, "scripts", "build-connector.mjs"), provider]);
  }

  await run("pnpm", ["run", "test:build"]);
  const testRoot = join(repositoryRoot, ".test-dist", "test");
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  const connectorTests = entries
    .filter((entry) => entry.isFile() && /^k02-.*\.test\.js$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const expectedTests = [
    "k02-correlation-state.test.js",
    "k02-crash-matrix.test.js",
    "k02-execution-boundaries.test.js",
    "k02-limits-timeouts.test.js",
    "k02-loader-boundary.test.js",
    "k02-provider-automata.test.js",
    "k02-recovery-outcomes.test.js",
    "k02-startup-state-package.test.js",
    "k02-state-scheduling.test.js",
    "k02-webhook-admission.test.js",
  ];
  if (
    connectorTests.length !== expectedTests.length ||
    connectorTests.some((file, index) => basename(file) !== expectedTests[index])
  ) {
    throw new Error("connector test inventory changed");
  }
  await run(process.execPath, ["--test", "--test-concurrency=1", ...connectorTests]);

  for (const provider of PROVIDERS) {
    await run(process.execPath, [join(repositoryRoot, "scripts", "stage-connector.mjs"), provider]);
    await run(process.execPath, [
      join(repositoryRoot, "scripts", "check-packed-connector.mjs"),
      provider,
    ]);
  }
}

try {
  await main();
} catch {
  process.stderr.write("a2a connector checks failed\n");
  process.exitCode = 1;
}
