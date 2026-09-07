import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "./artifact-tools.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const application = join(repository, ".build/desktop/app");
const hidden = join(repository, ".build/desktop/portability-hidden-app");
const packageDirectory = join(
  repository,
  `.build/desktop/packages/Embassys-${process.platform}-${process.arch}`,
);
const contents = await inventory(packageDirectory);
assert.ok(contents.entries.length > 100, "The package is incomplete.");
await rename(application, hidden);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repository, "desktop/scripts/verify.mjs"), "--packaged"],
      {
        cwd: packageDirectory,
        stdio: "inherit",
        timeout: 60_000,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Relocated package verification failed.")),
    );
  });
} finally {
  await rename(hidden, application);
}
console.log("Package has no external links and starts with its build source unavailable.");
