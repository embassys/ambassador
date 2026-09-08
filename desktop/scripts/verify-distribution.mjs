import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256, verifyInventory } from "./artifact-tools.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(repository, ".build/desktop/app/build-manifest.json"), "utf8"),
);
const directory = join(repository, ".build/desktop/distribution");
const stem = `Embassys-${manifest.app}-${process.platform}-${process.arch}-development`;
const record = JSON.parse(await readFile(join(directory, `${stem}.manifest.json`), "utf8"));
const extension =
  process.platform === "darwin" ? "dmg" : process.platform === "win32" ? "zip" : "tar.gz";
const archive = join(directory, `${stem}.${extension}`);
assert.equal(record.sha256, await sha256(archive), "The distribution archive changed.");
const root = await mkdtemp(join(tmpdir(), "embassys-distribution-"));
let mounted = false;
const mount = join(root, "volume");
try {
  let application;
  if (process.platform === "darwin") {
    await execute(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, archive],
      { timeout: 60_000 },
    );
    mounted = true;
    application = join(root, "copied");
    // Copy the exact packaged entries; the mounted HFS volume has its own metadata.
    for (const entry of record.inventory.entries.filter((item) => !item.path.includes("/")))
      await cp(join(mount, entry.path), join(application, entry.path), {
        recursive: true,
        verbatimSymlinks: true,
      });
    await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 30_000 });
    mounted = false;
  } else {
    await execute(process.platform === "win32" ? "tar.exe" : "tar", ["-xf", archive, "-C", root], {
      // Extracting the bundled runtime exceeded one minute on a Windows CI runner.
      timeout: process.platform === "win32" ? 180_000 : 60_000,
    });
    application = join(root, `Embassys-${process.platform}-${process.arch}`);
  }
  await verifyInventory(application, record.inventory);
  const resources = join(
    application,
    process.platform === "darwin" ? "Embassys.app/Contents/Resources" : "resources",
  );
  const result = await execute(
    process.execPath,
    [join(repository, "desktop/scripts/verify.mjs"), "--resources", resources],
    { timeout: 60_000 },
  );
  console.log(result.stdout.trim());
  console.log(
    "The extracted distribution passes its checksum, file inventory and real MCP worker test.",
  );
} finally {
  // Never recursively remove a still-mounted disk image.
  if (mounted) await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 30_000 });
  await rm(root, { recursive: true, force: true });
}
