import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const directory = join(repository, ".test-dist", "test");
const additional = new Set([
  "encrypted-groups.test.js",
  "visible-transcripts.test.js",
  "direct-delivery.test.js",
  "central-agent-permission.test.js",
  "central-rest.test.js",
  "outbound-actions.test.js",
  "message-box.test.js",
  "delivery-prompt.test.js",
]);
const files = (await readdir(directory))
  .filter(
    (name) => (name.startsWith("desktop-") && name.endsWith(".test.js")) || additional.has(name),
  )
  .sort();
if (files.length < 9) throw new Error("The desktop regression build is incomplete.");
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=2", ...files.map((name) => join(directory, name))],
  { cwd: repository, stdio: "inherit" },
);
if (result.error || result.status !== 0) process.exit(1);
