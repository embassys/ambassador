import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { selectTests, testOptions } from "./test-suites.mjs";

const root = join(process.cwd(), ".test-dist", "test");
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const compiledTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const options = testOptions(process.argv.slice(2));
const files = selectTests(root, compiledTests, options.suite);
if (options.suite !== "platform") {
  const scripts = await readdir(join(process.cwd(), "scripts"));
  files.push(
    ...scripts
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => join(process.cwd(), "scripts", file)),
  );
}
if (options.list) {
  process.stdout.write(`${files.join("\n")}\n`);
  process.exit(0);
}
const flags = options.coverage ? ["--experimental-test-coverage"] : [];
const concurrencyFlags = process.platform === "win32" ? ["--test-concurrency=1"] : [];
// TAP prints failure details immediately, even if a later test leaves work running.
const reporterFlags = process.env.CI ? ["--test-reporter=tap"] : [];

function run(arguments_) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) resolveRun();
      else reject(new Error("test command failed"));
    });
  });
}

try {
  await run(["--test", ...flags, ...concurrencyFlags, ...reporterFlags, ...files]);
} catch {
  process.exitCode = 1;
}
