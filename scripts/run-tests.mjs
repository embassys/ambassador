import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const root = join(process.cwd(), ".test-dist", "test");
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const compiledTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const files = compiledTests
  .filter(
    (file) =>
      !basename(file).startsWith("t03-") &&
      !basename(file).startsWith("t04-") &&
      !basename(file).startsWith("k02-") &&
      !basename(file).startsWith("k04-"),
  )
  .sort();
const k04Files = compiledTests.filter((file) => basename(file).startsWith("k04-"));
const expectedK04Tests = ["k04-fake-provider-crash-e2e.test.js", "k04-fake-provider-e2e.test.js"];

if (files.length === 0) {
  throw new Error(`No compiled tests found under ${root}`);
}
if (
  k04Files.length !== expectedK04Tests.length ||
  k04Files.some((file, index) => basename(file) !== expectedK04Tests[index])
) {
  throw new Error("K04 test inventory changed");
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
  await run(["--test", "--test-concurrency=1", ...flags, ...k04Files]);
} catch {
  process.exitCode = 1;
}
