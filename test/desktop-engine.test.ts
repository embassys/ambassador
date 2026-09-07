import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { engineSourceDigest, verifyBundledEngine } from "../src/desktop/engine.js";

test("bundled engine checks all source files and its exact host contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = join(root, "gateway");
  const source = join(gateway, "dist");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "worker.js"), "export const protocol = 1;");
  await writeFile(join(gateway, "package.json"), JSON.stringify({ version: "0.2.19" }));
  const manifest = {
    app: "0.1.0",
    core: "0.2.19",
    node: "24.19.0",
    electron: "44.2.0",
    runtimeSha256: "a".repeat(64),
    platform: process.platform,
    arch: process.arch,
    protocol: 1,
    source: await engineSourceDigest(source),
    qualification: "development",
  };
  const manifestPath = join(root, "build-manifest.json");
  const verify = () =>
    verifyBundledEngine({
      manifestPath,
      gateway,
      app: "0.1.0",
      electron: "44.2.0",
      platform: process.platform,
      arch: process.arch,
    });
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await verify()).node, "24.19.0");
  await writeFile(join(source, "other.js"), "changed source");
  await assert.rejects(verify(), /integrity/);
  await rm(join(source, "other.js"));
  for (const changed of [
    { protocol: 2 },
    { node: "26.7.0" },
    { core: "0.2.20" },
    { electron: "44.1.0" },
    { app: "0.2.0" },
    { source: "b".repeat(64) },
  ]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...changed }));
    await assert.rejects(verify());
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(source, "worker.js"), "modified worker");
  await assert.rejects(verify(), /integrity/);
});

test("engine source inventory refuses linked files", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-engine-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "outside.js"), "outside");
  await symlink("../outside.js", join(root, "source", "file.js"));
  await assert.rejects(engineSourceDigest(join(root, "source")));
});
