import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), ".test-dist", "test");
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .filter(
    (entry) =>
      !entry.name.startsWith("t03-") &&
      !entry.name.startsWith("t04-") &&
      !entry.name.startsWith("k02-"),
  )
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

if (files.length === 0) {
  throw new Error(`No compiled tests found under ${root}`);
}

const flags = process.argv.includes("--coverage") ? ["--experimental-test-coverage"] : [];
const child = spawn(process.execPath, ["--test", ...flags, ...files], {
  stdio: "inherit",
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
