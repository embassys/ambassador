import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const root = join(process.cwd(), ".test-dist", "test");
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const compiledTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const files = compiledTests.filter((file) => !basename(file).startsWith("t03-")).sort();

if (files.length === 0) {
  throw new Error(`No compiled tests found under ${root}`);
}

const flags = process.argv.includes("--coverage") ? ["--experimental-test-coverage"] : [];

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
  await run(["--test", ...flags, ...files]);
} catch {
  process.exitCode = 1;
}
